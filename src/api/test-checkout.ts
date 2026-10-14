import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../db/client";
import { activityEvents, ledgerAccounts, ledgerEntries, ledgerLines, payments } from "../db/schema";
import { accountBalance } from "../payments/ledger";
import { reconcile } from "../payments/reconcile";
import { signSandboxWebhook, simulateSandboxPayment } from "../payments/sandbox";
import { app } from "./app";
import { call, cleanupTestUsers, createProject, expect, registerUser } from "./test-helpers";

// Abandoned checkout, late payments, gateway alerts, the admin attention queue and reconciliation (sandbox gateway).
// Needs `npm run db:seed`. Run: npm run test:checkout
process.env.PAYMENTS_PROVIDER = "sandbox";

const stamp = Date.now().toString(36);
const LIKE = "checkout-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;
const code = (r: { json: any }) => r.json?.error?.code;

let A = { token: "", id: "" }; // owner, also the platform admin in this test
let S = { token: "", id: "" }; // stranger, not an admin
let projectId = "";
let mA = "", mB = "", mC = "";
let payA1 = "", payA2 = "", payB = "", payC1 = "", payC2 = "";

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const mk = async (title: string, key: string) => {
  const r = await call("POST", `/projects/${projectId}/milestones`, { body: { title, amountMinor: 100000, currency: "NGN" }, token: A.token, key: k(key) });
  expect(r.status === 201, `create milestone ${key} ${r.status} ${r.text}`);
  return r.json.milestone.id as string;
};
const payFor = (milestone: string, key: string) => call("POST", `/milestones/${milestone}/payments`, { body: {}, token: A.token, key: k(key) });
const refOf = async (id: string) => {
  const [r] = await db.select({ ref: payments.providerReference }).from(payments).where(eq(payments.id, id));
  expect(r?.ref, "payment has a reference");
  return r.ref as string;
};
const stateOf = async (id: string) => (await db.select({ s: payments.state }).from(payments).where(eq(payments.id, id)))[0]?.s;
const milestoneStatus = async (id: string) => (await call("GET", `/milestones/${id}`, { token: A.token })).json.milestone.status as string;
const events = async (type: string) => db.select().from(activityEvents).where(and(eq(activityEvents.projectId, projectId), eq(activityEvents.eventType, type)));

async function webhook(payload: unknown, opts: { signature?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = opts.signature === undefined ? signSandboxWebhook(raw) : opts.signature;
  if (sig) headers["x-paystack-signature"] = sig;
  const res = await app.request("/webhooks/sandbox", { method: "POST", headers, body: raw });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}
const chargeSuccess = (reference: string) => ({ event: "charge.success", data: { reference } });

test("pure: reconcile finds every kind of disagreement", async () => {
  const ours = (o: Partial<{ id: string; providerReference: string | null; state: string; amountMinor: number; currency: string; hasCaptureEntry: boolean }>) =>
    ({ id: "p", providerReference: "lp_a", state: "secured", amountMinor: 100, currency: "NGN", hasCaptureEntry: true, ...o });
  const gw = (o: Partial<{ reference: string; status: "success" | "failed" | "pending"; amountMinor: number; currency: string }>) =>
    ({ reference: "lp_a", status: "success" as const, amountMinor: 100, currency: "NGN", ...o });
  expect(reconcile([gw({})], [ours({})]).length === 0, "consistent data has no discrepancies");
  expect(reconcile([gw({})], []).map((d) => d.kind).join() === "unknown_at_our_side", "unknown reference");
  expect(reconcile([gw({ reference: "other_x" })], []).length === 0, "references we did not generate are ignored");
  expect(reconcile([gw({})], [ours({ state: "pending" })]).map((d) => d.kind).join() === "paid_but_not_secured", "paid but pending");
  expect(reconcile([gw({})], [ours({ state: "failed" })]).map((d) => d.kind).join() === "paid_after_expiry", "paid after expiry");
  expect(reconcile([gw({ amountMinor: 99 })], [ours({})]).map((d) => d.kind).join() === "amount_mismatch", "amount mismatch");
  expect(reconcile([gw({ currency: "USD" })], [ours({})]).map((d) => d.kind).join() === "amount_mismatch", "currency mismatch");
  expect(reconcile([], [ours({})]).map((d) => d.kind).join() === "secured_not_paid_at_gateway", "secured but absent at gateway");
  expect(reconcile([gw({ status: "failed" })], [ours({})]).map((d) => d.kind).join() === "secured_not_paid_at_gateway", "secured but failed at gateway");
  expect(reconcile([gw({})], [ours({ hasCaptureEntry: false })]).map((d) => d.kind).join() === "secured_without_ledger_entry", "no ledger entry");
  expect(reconcile([], [ours({ state: "pending" })]).length === 0, "an unpaid pending payment is fine");
});

test("setup: owner, stranger, project, three payable milestones", async () => {
  A = await registerUser(`checkout-${stamp}-a@test.invalid`);
  S = await registerUser(`checkout-${stamp}-s@test.invalid`);
  process.env.PLATFORM_ADMIN_USER_IDS = A.id;
  const p = await createProject(A.token, `co-${stamp}`, "Checkout tests");
  projectId = p.projectId;
  mA = await mk("A", "mA"); mB = await mk("B", "mB"); mC = await mk("C", "mC");
});

test("a FRESH pending payment still blocks a second one", async () => {
  delete process.env.PAYMENT_PENDING_TTL_MINUTES; // default 30 minutes
  const first = await payFor(mA, "pa1");
  expect(first.status === 201, `first ${first.status} ${first.text}`);
  payA1 = first.json.payment.id;
  const second = await payFor(mA, "pa1-again");
  expect(second.status === 409 && code(second) === "payment_exists", `second ${second.status} ${second.text}`);
  expect(await stateOf(payA1) === "pending", "the first payment is untouched");
});

test("a STALE unpaid checkout is expired and a new payment is created", async () => {
  process.env.PAYMENT_PENDING_TTL_MINUTES = "0"; // everything pending counts as stale
  const r = await payFor(mA, "pa2");
  expect(r.status === 201 && r.json.payment.id !== payA1, `retry ${r.status} ${r.text}`);
  payA2 = r.json.payment.id;
  expect(await stateOf(payA1) === "failed", "old payment closed as failed");
  expect(await stateOf(payA2) === "pending", "new payment pending");
  const exp = (await events("payment.expired")).filter((e) => e.subjectId === payA1);
  expect(exp.length === 1, `expected one payment.expired event, found ${exp.length}`);
  expect(await milestoneStatus(mA) === "pending", "milestone still pending");
});

test("a stale checkout that WAS paid is secured instead of duplicated", async () => {
  process.env.PAYMENT_PENDING_TTL_MINUTES = "30";
  const first = await payFor(mB, "pb1");
  payB = first.json.payment.id;
  simulateSandboxPayment(await refOf(payB)); // customer paid and never came back
  process.env.PAYMENT_PENDING_TTL_MINUTES = "0";
  const r = await payFor(mB, "pb2");
  expect(r.status === 200 && r.json.alreadyPaid === true && r.json.payment.id === payB && r.json.payment.state === "secured", `retry ${r.status} ${r.text}`);
  expect(await milestoneStatus(mB) === "funded", "milestone funded");
  expect((await db.select().from(payments).where(eq(payments.milestoneId, mB))).length === 1, "no second payment row");
  expect(await accountBalance(db, "protected_funds", `project:${projectId}`, "NGN") === 100000, "100000 protected");
});

test("late success: money arriving after expiry goes to SUSPENSE, once", async () => {
  process.env.PAYMENT_PENDING_TTL_MINUTES = "30";
  const first = await payFor(mC, "pc1");
  payC1 = first.json.payment.id;
  process.env.PAYMENT_PENDING_TTL_MINUTES = "0";
  const second = await payFor(mC, "pc2");
  payC2 = second.json.payment.id;
  expect(await stateOf(payC1) === "failed" && payC2 !== payC1, "first checkout expired");

  simulateSandboxPayment(await refOf(payC1)); // ...and the customer pays the OLD link after all
  const w = await webhook(chargeSuccess(await refOf(payC1)));
  expect(w.status === 200 && w.json.handled === true && w.json.outcome === "late_success", `webhook ${w.status} ${w.text}`);
  expect(await stateOf(payC1) === "failed", "the expired payment stays failed");
  expect(await accountBalance(db, "adjustments", `suspense:payment:${payC1}`, "NGN") === 100000, "100000 held in suspense");
  expect(await accountBalance(db, "protected_funds", `project:${projectId}`, "NGN") === 100000, "protected funds unchanged (only milestone B)");
  expect(await milestoneStatus(mC) === "pending", "late money does not fund the milestone");

  const again = await webhook(chargeSuccess(await refOf(payC1)));
  expect(again.status === 200 && again.json.handled === false, `replay ${again.text}`);
  const verify = await call("POST", `/payments/${payC1}/verify`, { token: A.token });
  expect(verify.status === 200 && verify.json.outcome === "unchanged", `verify ${verify.text}`);
  const entries = await db.select({ k: ledgerEntries.idempotencyKey }).from(ledgerEntries).where(eq(ledgerEntries.paymentId, payC1));
  expect(entries.length === 1 && entries[0].k === `payment:${payC1}:late_success`, `ledger entries: ${JSON.stringify(entries)}`);
  expect((await events("payment.late_success")).filter((e) => e.subjectId === payC1).length === 1, "exactly one late_success event");
});

test("the replacement checkout can still be paid normally", async () => {
  process.env.PAYMENT_PENDING_TTL_MINUTES = "30";
  simulateSandboxPayment(await refOf(payC2));
  const v = await call("POST", `/payments/${payC2}/verify`, { token: A.token });
  expect(v.status === 200 && v.json.outcome === "secured", `verify ${v.text}`);
  expect(await milestoneStatus(mC) === "funded", "milestone C funded");
  expect(await accountBalance(db, "protected_funds", `project:${projectId}`, "NGN") === 200000, "200000 protected (B and C)");
});

test("gateway refund/dispute events are logged for a human, once, and never touch money", async () => {
  const ref = await refOf(payC1);
  const before = await accountBalance(db, "protected_funds", `project:${projectId}`, "NGN");
  const refund = { event: "refund.processed", data: { transaction_reference: ref, amount: 100000 } };
  const r = await webhook(refund);
  expect(r.status === 200 && r.json.handled === true, `refund ${r.status} ${r.text}`);
  expect((await webhook(refund)).json.handled === false, "retry of the same body is not logged twice");
  const dispute = await webhook({ event: "charge.dispute.create", data: { transaction: { reference: ref }, status: "awaiting-merchant-response" } });
  expect(dispute.status === 200 && dispute.json.handled === true, `dispute ${dispute.text}`);
  const logged = await events("gateway.event_received");
  expect(logged.length === 2 && logged.every((e) => e.subjectId === payC1), `logged ${logged.length}`);
  expect(await accountBalance(db, "protected_funds", `project:${projectId}`, "NGN") === before, "money untouched");
  expect((await webhook(refund, { signature: null })).status === 401, "unsigned is rejected");
  expect((await webhook(refund, { signature: "deadbeef" })).status === 401, "bad signature is rejected");
  expect((await webhook({ event: "something.else", data: {} })).json.handled === false, "unrelated events are ignored");
});

test("admin attention queue: staff see the alerts, everyone else gets 404", async () => {
  const r = await call("GET", "/admin/attention", { token: A.token });
  expect(r.status === 200, `admin ${r.status} ${r.text}`);
  const mine = (r.json.events as any[]).filter((e) => e.projectId === projectId);
  const types = new Set(mine.map((e) => e.eventType));
  expect(types.has("payment.late_success") && types.has("gateway.event_received"), `types: ${[...types].join()}`);
  expect((await call("GET", "/admin/attention", { token: S.token })).status === 404, "non-admin gets 404");
  expect((await call("GET", "/admin/attention")).status === 401, "anonymous gets 401");
  expect((await call("GET", "/admin/payouts", { token: S.token })).status === 404, "payout queue is hidden too");
  const saved = process.env.PLATFORM_ADMIN_USER_IDS;
  process.env.PLATFORM_ADMIN_USER_IDS = "";
  expect((await call("GET", "/admin/attention", { token: A.token })).status === 404, "empty allowlist: nobody is admin");
  process.env.PLATFORM_ADMIN_USER_IDS = saved;
});

test("ledger stays balanced and nothing is posted twice", async () => {
  const rows = await db
    .select({ entry: ledgerLines.entryId, dir: ledgerLines.direction, amount: ledgerLines.amountMinor, cur: ledgerLines.currency })
    .from(ledgerLines)
    .innerJoin(ledgerEntries, eq(ledgerEntries.id, ledgerLines.entryId))
    .where(eq(ledgerEntries.projectId, projectId));
  const net = new Map<string, number>();
  for (const l of rows) net.set(l.entry, (net.get(l.entry) ?? 0) + (l.dir === "debit" ? l.amount : -l.amount));
  expect([...net.values()].every((n) => n === 0), "every entry balances");
  const accts = await db.select({ k: ledgerAccounts.kind }).from(ledgerAccounts).where(eq(ledgerAccounts.ownerKey, `suspense:payment:${payC1}`));
  expect(accts.length === 1 && accts[0].k === "adjustments", "one suspense account");
});

async function main() {
  let failed = 0;
  await cleanupTestUsers(LIKE);
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`PASS  ${name}`);
      } catch (e) {
        failed++;
        console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
      }
    }
  } finally {
    delete process.env.PAYMENT_PENDING_TTL_MINUTES;
    delete process.env.PLATFORM_ADMIN_USER_IDS;
    await cleanupTestUsers(LIKE);
    await queryClient.end();
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
