import "dotenv/config";
import { db, queryClient } from "../db/client.js";
import { postEntry } from "../payments/ledger.js";
import { call, cleanupTestUsers, expect, registerProvider, registerUser } from "./test-helpers.js";

// What an admin sees before approving a payout. Sandbox gateway. Needs `npm run db:seed`.
process.env.PAYMENTS_PROVIDER = "sandbox";

const stamp = Date.now().toString(36);
const LIKE = "adminview-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

let admin = { token: "", id: "" };
let S = { token: "", id: "" };
let P = { token: "", id: "", providerId: "" };
let payoutId = "";

test("setup: admin, stranger, a provider with earnings, a payout account and a pending payout", async () => {
  admin = await registerUser(`adminview-${stamp}-admin@test.invalid`);
  S = await registerUser(`adminview-${stamp}-s@test.invalid`);
  P = await registerProvider(`adminview-${stamp}-p@test.invalid`, `av-${stamp}`);
  process.env.PLATFORM_ADMIN_USER_IDS = admin.id;
  process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS = "0";
  delete process.env.PAYOUT_MIN_MINOR;
  await db.transaction(async (tx) => {
    await postEntry(tx, {
      kind: "adjustment", description: "test seed", idempotencyKey: `adminview:${P.providerId}:seed`,
      lines: [
        { account: "external_clearing", ownerKey: "provider:sandbox", direction: "debit", amountMinor: 500000, currency: "NGN" },
        { account: "provider_earnings", ownerKey: `provider:${P.providerId}`, direction: "credit", amountMinor: 500000, currency: "NGN" },
      ],
    });
  });
  const acct = await call("PUT", "/providers/me/payout-account", { body: { bankCode: "000", accountNumber: "0123454321", currency: "NGN" }, token: P.token, key: k("acct") });
  expect(acct.status === 200, `account ${acct.status} ${acct.text}`);
  const req = await call("POST", "/providers/me/payouts", { body: { amountMinor: 100000, currency: "NGN" }, token: P.token, key: k("req") });
  expect(req.status === 201, `payout ${req.status} ${req.text}`);
  payoutId = req.json.payout.id;
});

test("admin queue: names the provider and the destination, never the full account number", async () => {
  const r = await call("GET", "/admin/payouts?state=pending", { token: admin.token });
  expect(r.status === 200, `list ${r.status} ${r.text}`);
  const row = r.json.payouts.find((p: any) => p.id === payoutId);
  expect(row, "the pending payout is in the queue");
  expect(typeof row.providerName === "string" && row.providerName.length > 0, `provider name ${JSON.stringify(row)}`);
  expect(typeof row.accountName === "string" && row.accountName.length > 0, "account name from the bank");
  expect(row.accountLast4 === "4321" && row.bankCode === "000", `destination ${row.accountLast4} ${row.bankCode}`);
  expect(row.amountMinor === 100000 && row.currency === "NGN" && row.state === "pending", "amount and state");
  const text = JSON.stringify(row);
  expect(!text.includes("0123454321") && !("recipientCode" in row) && !("accountNumber" in row), "no full number, no recipient code");
});

test("admin queue: staff only", async () => {
  expect((await call("GET", "/admin/payouts?state=pending")).status === 401, "401");
  expect((await call("GET", "/admin/payouts?state=pending", { token: S.token })).status === 404, "a non-admin gets 404");
  expect((await call("GET", "/admin/payouts?state=pending", { token: P.token })).status === 404, "the provider gets 404 too");
});

async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS  ${name}`); }
      catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
    }
  } finally {
    await cleanupTestUsers(LIKE);
    await queryClient.end();
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
