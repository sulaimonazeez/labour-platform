import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { activityEvents, ledgerEntries, payouts, providerPayoutAccounts } from "../db/schema/index.js";
import { accountBalance, postEntry } from "../payments/ledger.js";
import { signSandboxWebhook, simulateSandboxTransfer } from "../payments/sandbox.js";
import { app } from "./app.js";
import { call, cleanupTestUsers, expect, registerProvider, registerUser } from "./test-helpers.js";

// Payouts against the SANDBOX gateway: reserve -> admin approve -> paid/failed, the ledger at every step, and the safety rules.
// Needs `npm run db:migrate` (payout tables) and `npm run db:seed`. Run: npm run test:payouts
process.env.PAYMENTS_PROVIDER = "sandbox";

const stamp = Date.now().toString(36);
const LIKE = "payouttest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;
const code = (r: { json: any }) => r.json?.error?.code;
const ACCOUNT = "0123454321";

let admin = { token: "", id: "" };
let S = { token: "", id: "" }; // stranger: no provider profile, not an admin
let P = { token: "", id: "", providerId: "" };
let X = "", Y = "", Z = "", W = "";

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const owner = () => `provider:${P.providerId}`;
const balance = async () => (await call("GET", "/providers/me/balance?currency=NGN", { token: P.token })).json.balance as { availableMinor: number; inTransitMinor: number; paidOutMinor: number };
const request = (amountMinor: number, key: string, token = P.token, currency = "NGN") => call("POST", "/providers/me/payouts", { body: { amountMinor, currency }, token, key: k(key) });
const adminCall = (path: string, token = admin.token, body: unknown = {}) => call("POST", `/admin/payouts/${path}`, { body, token });
const refOf = async (id: string) => (await db.select({ r: payouts.providerReference }).from(payouts).where(eq(payouts.id, id)))[0]?.r as string;
const stateOf = async (id: string) => (await db.select({ s: payouts.state }).from(payouts).where(eq(payouts.id, id)))[0]?.s;
const entryKeys = async (id: string) => (await db.select({ k: ledgerEntries.idempotencyKey }).from(ledgerEntries).where(eq(ledgerEntries.payoutId, id))).map((e) => e.k).sort();
const eventCount = async (type: string, subjectId: string) => (await db.select({ id: activityEvents.id }).from(activityEvents).where(and(eq(activityEvents.eventType, type), eq(activityEvents.subjectId, subjectId)))).length;
const setAccount = (key: string, over: Record<string, unknown> = {}) =>
  call("PUT", "/providers/me/payout-account", { body: { bankCode: "000", accountNumber: ACCOUNT, currency: "NGN", ...over }, token: P.token, key: k(key) });

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
const transferEvent = (event: string, reference: string) => ({ event, data: { reference, status: event.split(".")[1] } });

test("setup: admin, stranger, provider with 500,000 kobo of earnings", async () => {
  admin = await registerUser(`payouttest-${stamp}-admin@test.invalid`);
  S = await registerUser(`payouttest-${stamp}-s@test.invalid`);
  P = await registerProvider(`payouttest-${stamp}-p@test.invalid`, `po-${stamp}`);
  process.env.PLATFORM_ADMIN_USER_IDS = admin.id;
  process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS = "0";
  delete process.env.PAYOUT_MIN_MINOR;
  // Test-only seed standing in for released milestones (those flows are covered in test:payments).
  await db.transaction(async (tx) => {
    await postEntry(tx, {
      kind: "adjustment", description: "test seed", idempotencyKey: `payouttest:${P.providerId}:seed`,
      lines: [
        { account: "external_clearing", ownerKey: "provider:sandbox", direction: "debit", amountMinor: 500000, currency: "NGN" },
        { account: "provider_earnings", ownerKey: owner(), direction: "credit", amountMinor: 500000, currency: "NGN" },
      ],
    });
  });
  const b = await balance();
  expect(b.availableMinor === 500000 && b.inTransitMinor === 0 && b.paidOutMinor === 0, `balance ${JSON.stringify(b)}`);
});

test("a payout cannot be requested before a payout account exists", async () => {
  const r = await request(100000, "early");
  expect(r.status === 409 && code(r) === "payout_account_required", `early ${r.status} ${r.text}`);
  expect((await call("GET", "/providers/me/payout-account", { token: P.token })).status === 404, "no account yet");
});

test("banks list and payout-account validation", async () => {
  const banks = await call("GET", "/providers/banks?currency=NGN", { token: P.token });
  expect(banks.status === 200 && banks.json.banks.some((b: any) => b.code === "000"), `banks ${banks.text}`);
  expect((await call("GET", "/providers/banks")).status === 401, "banks need auth");
  expect((await call("PUT", "/providers/me/payout-account", { body: { bankCode: "000", accountNumber: ACCOUNT, currency: "NGN" }, token: P.token })).status === 400, "key required");
  expect((await setAccount("v1", { accountNumber: "12ab" })).status === 400, "bad number");
  expect((await setAccount("v2", { bankCode: "no spaces!" })).status === 400, "bad bank code");
  expect((await setAccount("v3", { currency: "NG" })).status === 400, "bad currency");
  expect((await setAccount("v4", { extra: 1 })).status === 400, "unknown field");
  const unresolvable = await setAccount("v5", { accountNumber: "9999990000" });
  expect(unresolvable.status === 502 && code(unresolvable) === "payment_provider_error", `unresolvable ${unresolvable.status} ${unresolvable.text}`);
  const stranger = await call("PUT", "/providers/me/payout-account", { body: { bankCode: "000", accountNumber: ACCOUNT, currency: "NGN" }, token: S.token, key: k("stranger") });
  expect(stranger.status === 404, `no provider profile: ${stranger.status}`);
});

test("set the payout account: name resolved, full number never stored or returned", async () => {
  const r = await setAccount("acct");
  expect(r.status === 200, `set ${r.status} ${r.text}`);
  const a = r.json.payoutAccount;
  expect(a.accountLast4 === "4321" && a.accountName === "SANDBOX ACCOUNT HOLDER" && a.bankCode === "000" && a.currency === "NGN", `account ${r.text}`);
  expect(!r.text.includes(ACCOUNT), "response must not contain the full account number");
  const row = (await db.select().from(providerPayoutAccounts).where(eq(providerPayoutAccounts.providerProfileId, P.providerId)))[0];
  expect(row && row.recipientCode.startsWith("RCP_") && !JSON.stringify(row).includes(ACCOUNT), "row stores only the recipient code and last 4");
  const g = await call("GET", "/providers/me/payout-account", { token: P.token });
  expect(g.status === 200 && g.json.payoutAccount.accountLast4 === "4321", "GET returns it");
  const ev = await db.select({ p: activityEvents.payload }).from(activityEvents).where(and(eq(activityEvents.eventType, "payout_account.set"), eq(activityEvents.subjectId, P.providerId)));
  expect(ev.length === 1 && !JSON.stringify(ev[0].p).includes(ACCOUNT), "activity event holds no full number");
  const replay = await setAccount("acct");
  expect(replay.replayed && replay.status === 200, "replay");
});

test("payouts are paused for a cooldown after the account changes", async () => {
  process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS = "24";
  const r = await request(100000, "cool");
  expect(r.status === 409 && code(r) === "payout_account_recently_changed" && r.json.error.details?.availableAt, `cooldown ${r.status} ${r.text}`);
  process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS = "0";
});

test("request rules: minimum, available earnings, currency, shape, permissions", async () => {
  const low = await request(5000, "low");
  expect(low.status === 400 && code(low) === "below_minimum" && low.json.error.details.minMinor === 10000, `low ${low.status} ${low.text}`);
  const big = await request(900000, "big");
  expect(big.status === 409 && code(big) === "insufficient_earnings" && big.json.error.details.availableMinor === 500000, `big ${big.status} ${big.text}`);
  const cur = await request(100000, "cur", P.token, "USD");
  expect(cur.status === 409 && code(cur) === "payout_account_currency_mismatch", `currency ${cur.status} ${cur.text}`);
  expect((await call("POST", "/providers/me/payouts", { body: { amountMinor: 100000, currency: "NGN" }, token: P.token })).status === 400, "key required");
  expect((await call("POST", "/providers/me/payouts", { body: { amountMinor: 1.5, currency: "NGN" }, token: P.token, key: k("frac") })).status === 400, "no fractional minor units");
  expect((await call("POST", "/providers/me/payouts", { body: { amountMinor: 100000, currency: "NGN", providerProfileId: P.providerId }, token: P.token, key: k("extra") })).status === 400, "unknown field");
  expect((await request(100000, "stranger", S.token)).status === 404, "no provider profile");
  expect((await request(100000, "anon", "")).status === 401, "anonymous");
  expect((await balance()).availableMinor === 500000, "nothing was reserved by the failed requests");
});

test("a request RESERVES earnings (pending payout, ledger entry) and replays safely", async () => {
  const r = await request(200000, "x");
  expect(r.status === 201 && r.json.payout.state === "pending" && r.json.payout.amountMinor === 200000, `request ${r.status} ${r.text}`);
  X = r.json.payout.id;
  const b = await balance();
  expect(b.availableMinor === 300000 && b.inTransitMinor === 200000, `after request ${JSON.stringify(b)}`);
  const replay = await request(200000, "x");
  expect(replay.replayed && replay.json.payout.id === X, "replay returns the same payout");
  expect((await balance()).availableMinor === 300000, "replay reserved nothing more");
  expect((await entryKeys(X)).join() === `payout:${X}:reserved`, `entries ${(await entryKeys(X)).join()}`);
  const list = await call("GET", "/providers/me/payouts", { token: P.token });
  expect(list.json.payouts.some((p: any) => p.id === X && p.state === "pending"), "listed");
});

test("two parallel requests cannot spend the same earnings", async () => {
  const rs = await Promise.all([request(200000, "race1"), request(200000, "race2")]);
  const ok = rs.filter((r) => r.status === 201);
  const no = rs.filter((r) => r.status === 409);
  expect(ok.length === 1 && no.length === 1 && code(no[0]) === "insufficient_earnings", `statuses ${rs.map((r) => r.status).join()}`);
  Y = ok[0].json.payout.id;
  const b = await balance();
  expect(b.availableMinor === 100000 && b.inTransitMinor === 400000, `after race ${JSON.stringify(b)}`);
});

test("only platform staff can see or approve payouts", async () => {
  expect((await adminCall(`${X}/approve`, P.token)).status === 404, "provider cannot approve their own payout");
  expect((await adminCall(`${X}/approve`, S.token)).status === 404, "stranger");
  expect((await adminCall(`${X}/approve`, "")).status === 401, "anonymous");
  expect((await adminCall("not-a-uuid/approve")).status === 404, "malformed id");
  expect((await call("GET", "/admin/payouts?state=bogus", { token: admin.token })).status === 400, "unknown state filter");
  const q = await call("GET", "/admin/payouts?state=pending", { token: admin.token });
  const ids = (q.json.payouts as any[]).map((p) => p.id);
  expect(q.status === 200 && ids.includes(X) && ids.includes(Y), `queue ${q.status}`);
  expect(await stateOf(X) === "pending", "nothing was sent");
});

test("approve: committed as `processing` with a deterministic reference; a repeat is refused", async () => {
  const r = await adminCall(`${X}/approve`);
  expect(r.status === 200 && r.json.payout.state === "processing" && r.json.outcome === "unchanged", `approve ${r.status} ${r.text}`);
  expect(r.json.payout.providerReference === `lpo_${X.replaceAll("-", "")}`, "reference derived from the payout id");
  const again = await adminCall(`${X}/approve`);
  expect(again.status === 409 && code(again) === "payout_not_pending", `repeat ${again.status} ${again.text}`);
  const rej = await adminCall(`${X}/reject`);
  expect(rej.status === 409 && code(rej) === "payout_not_pending", "cannot reject once processing");
  const v = await adminCall(`${X}/verify`);
  expect(v.status === 200 && v.json.outcome === "unchanged" && v.json.gatewayStatus === "processing", `verify ${v.text}`);
});

test("success: transfer.success webhook pays it once; the ledger moves reserved money out", async () => {
  const ref = await refOf(X);
  simulateSandboxTransfer(ref, "paid");
  expect((await webhook(transferEvent("transfer.success", ref), { signature: null })).status === 401, "unsigned rejected");
  const w = await webhook(transferEvent("transfer.success", ref));
  expect(w.status === 200 && w.json.handled === true && w.json.outcome === "paid", `webhook ${w.status} ${w.text}`);
  expect(await stateOf(X) === "paid", "paid");
  const b = await balance();
  expect(b.availableMinor === 100000 && b.inTransitMinor === 200000 && b.paidOutMinor === 200000, `after paid ${JSON.stringify(b)}`);
  expect((await entryKeys(X)).join() === `payout:${X}:paid,payout:${X}:reserved`, `entries ${(await entryKeys(X)).join()}`);
  const replay = await webhook(transferEvent("transfer.success", ref));
  expect(replay.json.handled === false, "replay is a no-op");
  expect((await adminCall(`${X}/verify`)).json.outcome === "unchanged", "admin verify of a paid payout is a no-op");
  expect((await entryKeys(X)).length === 2, "still two entries");
  expect(await eventCount("payout.paid", X) === 1, "one payout.paid event");
});

test("failure: transfer.failed returns the earnings, once", async () => {
  const a = await adminCall(`${Y}/approve`);
  expect(a.status === 200 && a.json.payout.state === "processing", `approve Y ${a.text}`);
  const ref = await refOf(Y);
  simulateSandboxTransfer(ref, "failed");
  const w = await webhook(transferEvent("transfer.failed", ref));
  expect(w.status === 200 && w.json.outcome === "failed", `webhook ${w.text}`);
  expect(await stateOf(Y) === "failed", "failed");
  const row = (await db.select({ r: payouts.failureReason }).from(payouts).where(eq(payouts.id, Y)))[0];
  expect(row.r === "gateway_failed", `reason ${row.r}`);
  const b = await balance();
  expect(b.availableMinor === 300000 && b.inTransitMinor === 0 && b.paidOutMinor === 200000, `after failure ${JSON.stringify(b)}`);
  expect((await webhook(transferEvent("transfer.failed", ref))).json.handled === false, "replay is a no-op");
  expect((await entryKeys(Y)).join() === `payout:${Y}:reserved,payout:${Y}:returned`, `entries ${(await entryKeys(Y)).join()}`);
});

test("a reversal AFTER paid is flagged for a human, not auto-booked", async () => {
  const ref = await refOf(X);
  simulateSandboxTransfer(ref, "failed"); // the gateway later claims the transfer was reversed
  const w = await webhook(transferEvent("transfer.reversed", ref));
  expect(w.status === 200 && w.json.outcome === "reversal_after_paid", `webhook ${w.text}`);
  expect(await stateOf(X) === "paid", "state unchanged");
  expect(await eventCount("payout.reversal_after_paid", X) === 1, "one flag raised");
  await webhook(transferEvent("transfer.reversed", ref));
  expect(await eventCount("payout.reversal_after_paid", X) === 1, "no duplicate flag");
  const att = await call("GET", "/admin/attention", { token: admin.token });
  expect((att.json.events as any[]).some((e) => e.eventType === "payout.reversal_after_paid" && e.subjectId === X), "visible in the attention queue");
});

test("reject returns the earnings; a rejected payout cannot be approved", async () => {
  const r = await request(50000, "z");
  Z = r.json.payout.id;
  expect((await balance()).availableMinor === 250000, "reserved");
  const rej = await adminCall(`${Z}/reject`, admin.token, { reason: "Needs identity check" });
  expect(rej.status === 200 && rej.json.payout.state === "cancelled" && rej.json.payout.failureReason === "Needs identity check", `reject ${rej.text}`);
  expect((await balance()).availableMinor === 300000, "returned");
  expect((await entryKeys(Z)).join() === `payout:${Z}:reserved,payout:${Z}:returned`, "entries");
  expect((await adminCall(`${Z}/approve`)).status === 409, "cannot approve a cancelled payout");
  expect((await adminCall(`${Z}/reject`)).status === 409, "cannot reject twice");
  expect((await adminCall(`${Z}/reject`, S.token)).status === 404, "non-admin cannot reject");
});

test("the payout account cannot be changed while a payout is in flight", async () => {
  const r = await request(20000, "w");
  W = r.json.payout.id;
  const blocked = await setAccount("acct2", { accountNumber: "0123459876" });
  expect(blocked.status === 409 && code(blocked) === "payouts_in_flight", `blocked ${blocked.status} ${blocked.text}`);
  expect((await adminCall(`${W}/reject`)).status === 200, "reject W");
  const ok = await setAccount("acct3", { accountNumber: "0123459876" });
  expect(ok.status === 200 && ok.json.payoutAccount.accountLast4 === "9876", `changed ${ok.status} ${ok.text}`);
  const ev = await db.select({ p: activityEvents.payload }).from(activityEvents).where(and(eq(activityEvents.eventType, "payout_account.set"), eq(activityEvents.subjectId, P.providerId)));
  expect(ev.some((e: any) => e.p.replaced === true), "replacement recorded");
});

test("a transfer the gateway never heard of: left alone while fresh, failed (and refunded) once aged", async () => {
  const r = await request(30000, "v");
  const V = r.json.payout.id as string;
  await db.execute(sql`update payouts set state = 'processing', provider_reference = ${`lpo_unknown${stamp}`}, updated_at = now() where id = ${V}`);
  const fresh = await adminCall(`${V}/verify`);
  expect(fresh.status === 200 && fresh.json.outcome === "unchanged" && fresh.json.gatewayStatus === "not_found", `fresh ${fresh.text}`);
  await db.execute(sql`update payouts set updated_at = now() - interval '1 hour' where id = ${V}`);
  const aged = await adminCall(`${V}/verify`);
  expect(aged.status === 200 && aged.json.outcome === "failed" && aged.json.payout.failureReason === "not_found_at_gateway", `aged ${aged.text}`);
  expect((await entryKeys(V)).join() === `payout:${V}:reserved,payout:${V}:returned`, "reservation returned");
});

test("webhook for an unknown transfer reference is acknowledged and ignored", async () => {
  const w = await webhook(transferEvent("transfer.success", `lpo_nothing${stamp}`));
  expect(w.status === 200 && w.json.handled === false, `unknown ${w.text}`);
});

test("ledger: reserved + available always equals total earnings; every entry balances", async () => {
  const b = await balance();
  expect(b.availableMinor + b.inTransitMinor + b.paidOutMinor === 500000, `conservation ${JSON.stringify(b)}`);
  expect(await accountBalance(db, "payout_clearing", owner(), "NGN") === b.inTransitMinor, "payout_clearing equals in-transit");
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
    delete process.env.PLATFORM_ADMIN_USER_IDS;
    delete process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS;
    await cleanupTestUsers(LIKE);
    await queryClient.end();
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
