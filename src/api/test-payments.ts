import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client";
import { activityEvents, ledgerAccounts, ledgerEntries, ledgerLines, payments } from "../db/schema";
import { computeFeeMinor, pickFeeRule, type FeeRule } from "../engine/fees";
import { accountBalance } from "../payments/ledger";
import { signSandboxWebhook, simulateSandboxPayment } from "../payments/sandbox";
import { app } from "./app";
import { call, cleanupTestUsers, createProject, expect, registerProvider, registerUser } from "./test-helpers";
import { forceFunded } from "./test-fund";

// Payments, ledger and webhooks against the SANDBOX provider (no real gateway). Needs `npm run db:seed`.
// Run: npm run test:payments
process.env.PAYMENTS_PROVIDER = "sandbox";

const stamp = Date.now().toString(36);
const LIKE = "paytest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;
const code = (r: { json: any }) => r.json?.error?.code;

let A = { token: "", id: "" }; // project owner (pays and releases)
let S = { token: "", id: "" }; // stranger
let P1 = { token: "", id: "", providerId: "" };
let projectId = "";
let as1 = "";
let m1 = ""; // 300000, as1
let m2 = ""; // 200000, as1
let m3 = ""; // 100000, no assignment
let m4 = ""; // 100000, as1, never paid
let pay1 = "";
let pay2 = "";
let pay3b = "";

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const quoteBody = () => ({
  currency: "NGN",
  validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  lines: [{ kind: "labour", description: "Work", quantity: 1, unitPriceMinor: 900000 }],
});

async function award(task: string, p: { token: string; providerId: string }, tag: string): Promise<string> {
  const inv = await call("POST", `/tasks/${task}/invitations`, { body: { providerProfileId: p.providerId }, token: A.token, key: k(`i-${tag}`) });
  expect(inv.status === 201, `invite ${inv.status} ${inv.text}`);
  const q = await call("POST", `/tasks/${task}/quotes`, { body: quoteBody(), token: p.token, key: k(`q-${tag}`) });
  expect(q.status === 201, `quote ${q.status} ${q.text}`);
  expect((await call("POST", `/quotes/${q.json.quote.id}/submit`, { body: {}, token: p.token, key: k(`s-${tag}`) })).status === 200, "submit quote");
  const acc = await call("POST", `/quotes/${q.json.quote.id}/accept`, { body: {}, token: A.token, key: k(`a-${tag}`) });
  expect(acc.status === 200, `accept quote ${acc.status} ${acc.text}`);
  const id = acc.json.assignment.id as string;
  expect((await call("POST", `/assignments/${id}/accept`, { body: {}, token: p.token, key: k(`aa-${tag}`) })).status === 200, "accept assignment");
  return id;
}

const mk = async (body: Record<string, unknown>, key: string) => {
  const r = await call("POST", `/projects/${projectId}/milestones`, { body: { currency: "NGN", ...body }, token: A.token, key: k(key) });
  expect(r.status === 201, `create milestone ${key} ${r.status} ${r.text}`);
  return r.json.milestone.id as string;
};

const refOf = async (paymentId: string) => {
  const [r] = await db.select({ ref: payments.providerReference }).from(payments).where(eq(payments.id, paymentId));
  expect(r?.ref, "payment has a provider reference");
  return r.ref as string;
};

const payFor = (milestone: string, key: string, token = A.token) => call("POST", `/milestones/${milestone}/payments`, { body: {}, token, key: k(key) });
const verify = (id: string, token = A.token) => call("POST", `/payments/${id}/verify`, { token });
const milestoneStatus = async (id: string) => (await call("GET", `/milestones/${id}`, { token: A.token })).json.milestone.status as string;

async function webhook(provider: string, payload: unknown, opts: { signature?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = opts.signature === undefined ? signSandboxWebhook(raw) : opts.signature;
  if (sig) headers["x-paystack-signature"] = sig;
  const res = await app.request(`/webhooks/${provider}`, { method: "POST", headers, body: raw });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

async function projectLines() {
  return db
    .select({
      kind: ledgerEntries.kind, key: ledgerEntries.idempotencyKey, account: ledgerAccounts.kind, owner: ledgerAccounts.ownerKey,
      dir: ledgerLines.direction, amount: ledgerLines.amountMinor, currency: ledgerLines.currency,
    })
    .from(ledgerLines)
    .innerJoin(ledgerEntries, eq(ledgerEntries.id, ledgerLines.entryId))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerLines.accountId))
    .where(eq(ledgerEntries.projectId, projectId));
}
const entryCount = async (kind?: string) => new Set((await projectLines()).filter((l) => !kind || l.kind === kind).map((l) => l.key)).size;

test("pure: fee rules, rounding, clamps, rule choice", async () => {
  const base: FeeRule = { marketId: null, categoryId: null, basisPoints: 1000, minFeeMinor: null, maxFeeMinor: null, currency: null, effectiveFrom: "2020-01-01", effectiveTo: null };
  expect(computeFeeMinor(300000, base, "NGN") === 30000, "10% of 300000");
  expect(computeFeeMinor(5, base, "NGN") === 1, "0.5 rounds half up to 1");
  expect(computeFeeMinor(4, base, "NGN") === 0, "0.4 rounds to 0");
  expect(computeFeeMinor(100000, null, "NGN") === 0, "no rule, no fee");
  expect(computeFeeMinor(100000, { ...base, basisPoints: 100, minFeeMinor: 5000, currency: "NGN" }, "NGN") === 5000, "min fee");
  expect(computeFeeMinor(100000, { ...base, basisPoints: 5000, maxFeeMinor: 20000, currency: "NGN" }, "NGN") === 20000, "max fee");
  expect(computeFeeMinor(100000, { ...base, basisPoints: 100, minFeeMinor: 5000, currency: "USD" }, "NGN") === 1000, "min/max ignored for another currency");
  expect(computeFeeMinor(100, { ...base, basisPoints: 10000, minFeeMinor: 500, currency: "NGN" }, "NGN") === 100, "fee never exceeds the amount");
  const ctx = { marketId: "m-ng", currency: "NGN", today: "2026-10-06" };
  const global = base;
  const ng = { ...base, marketId: "m-ng", basisPoints: 800 };
  expect(pickFeeRule([global, ng], ctx)?.basisPoints === 800, "market rule beats global");
  expect(pickFeeRule([global, { ...ng, marketId: "m-gh" }], ctx)?.basisPoints === 1000, "other market ignored");
  expect(pickFeeRule([{ ...global, effectiveTo: "2026-01-01" }], ctx) === null, "expired rule ignored");
  expect(pickFeeRule([{ ...global, effectiveFrom: "2027-01-01" }], ctx) === null, "future rule ignored");
  expect(pickFeeRule([{ ...global, categoryId: "c" }], ctx) === null, "category rules not applied yet");
});

test("setup: owner, stranger, awarded provider, four milestones", async () => {
  A = await registerUser(`paytest-${stamp}-a@test.invalid`);
  S = await registerUser(`paytest-${stamp}-s@test.invalid`);
  P1 = await registerProvider(`paytest-${stamp}-p1@test.invalid`, `pp1-${stamp}`);
  const p = await createProject(A.token, `pa-${stamp}`, "Fix the leaking tap");
  projectId = p.projectId;
  expect((await call("POST", `/tasks/${p.taskId}/transition`, { body: { to: "ready" }, token: A.token, key: k("r1") })).status === 200, "task ready");
  as1 = await award(p.taskId, P1, "p1");
  m1 = await mk({ title: "Part 1", amountMinor: 300000, assignmentId: as1 }, "m1");
  m2 = await mk({ title: "Part 2", amountMinor: 200000, assignmentId: as1 }, "m2");
  m3 = await mk({ title: "Materials", amountMinor: 100000 }, "m3");
  m4 = await mk({ title: "Part 4", amountMinor: 100000, assignmentId: as1 }, "m4");
});

test("create payment: auth, permissions, replay, one live payment per milestone", async () => {
  expect((await call("POST", `/milestones/${m1}/payments`, { body: {} })).status === 401, "401");
  const noKey = await call("POST", `/milestones/${m1}/payments`, { body: {}, token: A.token });
  expect(noKey.status === 400 && code(noKey) === "idempotency_key_required", `no key ${noKey.status}`);
  expect((await payFor(m1, "pay-s", S.token)).status === 404, "stranger 404");
  expect((await payFor(m1, "pay-p1", P1.token)).status === 404, "provider-only member 404: money is not theirs to start");
  expect((await call("POST", "/milestones/not-a-uuid/payments", { body: {}, token: A.token, key: k("bad") })).status === 404, "malformed id 404");
  const bad = await call("POST", `/milestones/${m1}/payments`, { body: { amountMinor: 1 }, token: A.token, key: k("pay-extra") });
  expect(bad.status === 400, `client cannot choose the amount ${bad.status}`);

  const ok = await payFor(m1, "pay-m1");
  expect(ok.status === 201, `create ${ok.status} ${ok.text}`);
  const pay = ok.json.payment;
  expect(pay.state === "pending" && pay.amountMinor === 300000 && pay.currency === "NGN" && pay.providerCode === "sandbox", `payment ${JSON.stringify(pay)}`);
  expect(typeof ok.json.checkoutUrl === "string" && ok.json.checkoutUrl.length > 10, "checkout url");
  pay1 = pay.id;
  const replay = await payFor(m1, "pay-m1");
  expect(replay.replayed && replay.json.payment.id === pay1, "replay returns the same payment");
  const second = await payFor(m1, "pay-m1-again");
  expect(second.status === 409 && code(second) === "payment_exists", `second ${second.status} ${second.text}`);
  expect(await milestoneStatus(m1) === "pending", "a pending payment does not fund the milestone");
  expect((await db.select().from(payments).where(eq(payments.milestoneId, m1))).length === 1, "exactly one payment row");
});

test("verify: unpaid stays pending; others cannot verify", async () => {
  const r = await verify(pay1);
  expect(r.status === 200 && r.json.payment.state === "pending" && r.json.providerStatus === "pending", `unpaid ${r.status} ${r.text}`);
  expect((await verify(pay1, S.token)).status === 404, "stranger 404");
  expect((await verify(pay1, P1.token)).status === 404, "provider-only 404");
  expect((await call("GET", `/payments/${pay1}`, { token: A.token })).json.payment.state === "pending", "GET works for the owner");
  expect((await call("GET", `/payments/${pay1}`, { token: S.token })).status === 404, "GET 404 for stranger");
  expect((await call("GET", "/payments/not-a-uuid", { token: A.token })).status === 404, "malformed id 404");
});

test("verify after payment: secured once, ledger posted once, milestone funded", async () => {
  simulateSandboxPayment(await refOf(pay1));
  const r = await verify(pay1);
  expect(r.status === 200 && r.json.outcome === "secured" && r.json.payment.state === "secured", `verify ${r.status} ${r.text}`);
  expect(r.json.payment.methodCode === "sandbox", "channel recorded");
  expect(await milestoneStatus(m1) === "funded", "milestone funded");
  expect(await accountBalance(db, "protected_funds", `project:${projectId}`, "NGN") === 300000, "protected funds hold 300000");
  expect(await entryCount("payment_captured") === 1, "one capture entry");
  const again = await verify(pay1);
  expect(again.status === 200 && again.json.outcome === "unchanged" && again.json.payment.state === "secured", `second verify ${again.text}`);
  expect(await entryCount("payment_captured") === 1, "still one capture entry after a repeat");
  const dup = await payFor(m1, "pay-m1-dup");
  expect(dup.status === 409, `funded milestone cannot be paid again ${dup.status}`);
});

test("webhook: signature required, replays harmless, gateway re-checked, unknown ignored", async () => {
  const ref1 = await refOf(pay1);
  const body = { event: "charge.success", data: { reference: ref1 } };
  expect((await webhook("sandbox", body, { signature: null })).status === 401, "missing signature 401");
  expect((await webhook("sandbox", body, { signature: "0".repeat(128) })).status === 401, "wrong signature 401");
  expect((await webhook("paystack", body)).status === 404, "a webhook for a provider that is not configured is 404");
  const replay = await webhook("sandbox", body);
  expect(replay.status === 200 && replay.json.handled === false, `replay of a secured payment ${replay.text}`);
  expect(await entryCount("payment_captured") === 1, "replay posted nothing");
  const other = await webhook("sandbox", { event: "transfer.success", data: { reference: ref1 } });
  expect(other.status === 200 && other.json.handled === false, "other events are acknowledged and ignored");
  const unknown = await webhook("sandbox", { event: "charge.success", data: { reference: "lp_does_not_exist" } });
  expect(unknown.status === 200 && unknown.json.handled === false, "unknown reference acknowledged and ignored");

  // m2: paid, and the webhook alone (no verify call) secures it.
  const c2 = await payFor(m2, "pay-m2");
  expect(c2.status === 201, `m2 ${c2.status} ${c2.text}`);
  pay2 = c2.json.payment.id;
  const ref2 = await refOf(pay2);
  const early = await webhook("sandbox", { event: "charge.success", data: { reference: ref2 } });
  expect(early.status === 200 && early.json.handled === false, "a webhook claim is not enough: the gateway says unpaid");
  expect((await call("GET", `/payments/${pay2}`, { token: A.token })).json.payment.state === "pending", "still pending");
  simulateSandboxPayment(ref2);
  const real = await webhook("sandbox", { event: "charge.success", data: { reference: ref2 } });
  expect(real.status === 200 && real.json.handled === true && real.json.outcome === "secured", `webhook secure ${real.text}`);
  expect((await call("GET", `/payments/${pay2}`, { token: A.token })).json.payment.state === "secured", "secured by webhook");
  expect(await milestoneStatus(m2) === "funded", "m2 funded");
  expect(await entryCount("payment_captured") === 2, "two capture entries");
});

test("failed payment: milestone untouched, a new attempt is allowed", async () => {
  const c = await payFor(m3, "pay-m3a");
  expect(c.status === 201, `m3 ${c.status} ${c.text}`);
  const id = c.json.payment.id as string;
  simulateSandboxPayment(await refOf(id), "failed");
  const v = await verify(id);
  expect(v.status === 200 && v.json.outcome === "failed" && v.json.payment.state === "failed", `failed ${v.text}`);
  expect(await milestoneStatus(m3) === "pending", "milestone still pending");
  expect(await entryCount("payment_captured") === 2, "nothing posted for a failed payment");
  const retry = await payFor(m3, "pay-m3b");
  expect(retry.status === 201 && retry.json.payment.id !== id, `retry ${retry.status} ${retry.text}`);
  pay3b = retry.json.payment.id;
});

test("race: verify and webhook at the same instant capture exactly once", async () => {
  const ref = await refOf(pay3b);
  simulateSandboxPayment(ref);
  const [a, b, c] = await Promise.all([
    verify(pay3b),
    webhook("sandbox", { event: "charge.success", data: { reference: ref } }),
    verify(pay3b),
  ]);
  expect(a.status === 200 && b.status === 200 && c.status === 200, `statuses ${a.status} ${b.status} ${c.status}`);
  expect((await call("GET", `/payments/${pay3b}`, { token: A.token })).json.payment.state === "secured", "secured");
  const keys = (await projectLines()).filter((l) => l.key === `payment:${pay3b}:captured`);
  expect(keys.length === 2, `one entry = two lines, got ${keys.length}`);
  expect(await entryCount("payment_captured") === 3, "three capture entries in total");
  expect(await accountBalance(db, "protected_funds", `project:${projectId}`, "NGN") === 600000, "protected funds 300000 + 200000 + 100000");
});

test("release: only approved work, only money roles, exactly once", async () => {
  const rel = (id: string, key: string, token = A.token) => call("POST", `/milestones/${id}/release`, { body: {}, token, key: k(key) });
  const early = await rel(m1, "rel-early");
  expect(early.status === 409 && code(early) === "milestone_not_approved", `unapproved ${early.status} ${early.text}`);

  expect((await call("POST", `/milestones/${m1}/submit`, { body: {}, token: P1.token, key: k("m1-sub") })).status === 200, "provider submits a funded milestone");
  expect((await call("POST", `/milestones/${m1}/approve`, { body: {}, token: A.token, key: k("m1-app") })).status === 200, "owner approves");
  expect((await rel(m1, "rel-s", S.token)).status === 404, "stranger 404");
  expect((await rel(m1, "rel-p", P1.token)).status === 404, "the provider cannot release their own payment");
  expect((await call("POST", `/milestones/${m1}/release`, { body: {}, token: A.token })).status === 400, "key required");

  const ok = await rel(m1, "rel-ok");
  expect(ok.status === 200, `release ${ok.status} ${ok.text}`);
  const r = ok.json.release;
  expect(r.amountMinor === 300000 && r.feeMinor + r.earningsMinor === 300000 && r.currency === "NGN", `split ${JSON.stringify(r)}`);
  expect(ok.json.milestone.status === "released", "milestone released");
  expect(ok.json.payment.state === "released" && ok.json.payment.releasedMinor === 300000, `payment ${JSON.stringify(ok.json.payment)}`);

  expect(await accountBalance(db, "provider_earnings", `provider:${P1.providerId}`, "NGN") === r.earningsMinor, "provider earnings credited");
  expect(await accountBalance(db, "protected_funds", `project:${projectId}`, "NGN") === 300000, "protected funds now 200000 + 100000");
  if (r.feeMinor > 0) {
    const fees = (await projectLines()).filter((l) => l.account === "platform_fees");
    expect(fees.length === 1 && fees[0].amount === r.feeMinor && fees[0].dir === "credit", "platform fee line");
  }

  expect((await rel(m1, "rel-ok")).replayed, "replay");
  const twice = await rel(m1, "rel-twice");
  expect(twice.status === 409 && code(twice) === "milestone_not_approved", `second release ${twice.status} ${twice.text}`);
  expect(await accountBalance(db, "provider_earnings", `provider:${P1.providerId}`, "NGN") === r.earningsMinor, "no double credit");
});

test("unfunded work: a stage with money in it cannot be submitted before it is funded (PRD §48)", async () => {
  const un = await call("POST", `/milestones/${m4}/submit`, { body: {}, token: P1.token, key: k("m4-unfunded") });
  expect(un.status === 409 && code(un) === "milestone_not_funded", `unfunded submit ${un.status} ${un.text}`);
  expect(await milestoneStatus(m4) === "pending", "m4 still pending");
});

test("release: an approved milestone with no secured payment is refused", async () => {
  await forceFunded(m4); // a funded status with no payment behind it: the inconsistent case release must still refuse
  expect((await call("POST", `/milestones/${m4}/submit`, { body: {}, token: P1.token, key: k("m4-sub") })).status === 200, "submit m4");
  expect((await call("POST", `/milestones/${m4}/approve`, { body: {}, token: A.token, key: k("m4-app") })).status === 200, "approve m4");
  const r = await call("POST", `/milestones/${m4}/release`, { body: {}, token: A.token, key: k("rel-m4") });
  expect(r.status === 409 && code(r) === "no_secured_payment", `no payment ${r.status} ${r.text}`);
  expect(await milestoneStatus(m4) === "approved", "m4 unchanged");
});

test("ledger integrity: balanced per currency, unique keys, expected entries", async () => {
  const lines = await projectLines();
  const net = new Map<string, number>();
  for (const l of lines) net.set(`${l.key}|${l.currency}`, (net.get(`${l.key}|${l.currency}`) ?? 0) + (l.dir === "debit" ? l.amount : -l.amount));
  for (const [key, v] of net) expect(v === 0, `entry ${key} is unbalanced by ${v}`);
  expect(await entryCount("payment_captured") === 3, "three captures");
  expect(await entryCount("milestone_released") === 1, "one release");
  expect(lines.every((l) => l.currency === "NGN"), "all NGN");
  expect(lines.filter((l) => l.account === "external_clearing" && l.dir === "debit").length === 3, "three gateway debits");
});

test("activity: one event per step, webhook actor recorded", async () => {
  const ev = await db.select({ t: activityEvents.eventType, a: activityEvents.actorType }).from(activityEvents).where(eq(activityEvents.projectId, projectId));
  const n = (t: string) => ev.filter((e) => e.t === t).length;
  expect(n("payment.initiated") === 4, `initiated ${n("payment.initiated")}`);
  expect(n("payment.secured") === 3, `secured ${n("payment.secured")}`);
  expect(n("payment.failed") === 1, `failed ${n("payment.failed")}`);
  expect(n("milestone.released") === 1, `released ${n("milestone.released")}`);
  expect(n("payment.amount_mismatch") === 0, "no mismatches");
  expect(ev.some((e) => e.t === "payment.secured" && e.a === "provider_webhook"), "one secure came from the webhook");
  expect(ev.some((e) => e.t === "payment.secured" && e.a === "user"), "one secure came from a user verify");
});

async function main() {
  let failed = 0;
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
    await cleanupTestUsers(LIKE);
    await queryClient.end();
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
