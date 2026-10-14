import "dotenv/config";
import readline from "node:readline/promises";
import { db, queryClient } from "../db/client.js";
import { postEntry } from "../payments/ledger.js";
import { call, cleanupTestUsers, expect, registerProvider, registerUser } from "../api/test-helpers.js";

// LIVE payout test against Paystack TEST mode (localhost, no real money). Run AFTER `npm run live:paystack` has passed.
//   npm run live:payout
// It makes a provider, gives them 5,000 NGN of test earnings in OUR ledger, resolves a bank account through Paystack,
// requests a 1,000 NGN payout, approves it as a platform admin, and polls Paystack until the transfer settles.
// Paystack test-mode transfers can fail for reasons that are settings, not code: see the hints printed on failure.

const LIKE = "livepayout-%@example.com";
const stamp = Date.now().toString(36);
const k = (n: string) => `${n}-${stamp}`;
const key = process.env.PAYSTACK_SECRET_KEY?.trim();
if (!key) { console.error("PAYSTACK_SECRET_KEY is not set in .env (use your Paystack TEST secret key, sk_test_...)"); process.exit(1); }
if (!key.startsWith("sk_test_")) { console.error("Refusing to run: this script only accepts a TEST key (sk_test_...)."); process.exit(1); }
process.env.PAYMENTS_PROVIDER = "paystack";
process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS = "0";

const step = (s: string) => console.log(`\n== ${s}`);

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await cleanupTestUsers(LIKE);

    step("1. Provider, admin, and 5,000 NGN of TEST earnings in our ledger");
    const admin = await registerUser(`livepayout-${stamp}-admin@example.com`);
    const prov = await registerProvider(`livepayout-${stamp}-prov@example.com`, `lp-${stamp}`);
    process.env.PLATFORM_ADMIN_USER_IDS = admin.id;
    await db.transaction(async (tx) => {
    await postEntry(tx, {
        kind: "adjustment", description: "live payout test seed", idempotencyKey: `payouttest:${prov.providerId}:seed`,
        lines: [
          { account: "external_clearing", ownerKey: "provider:paystack", direction: "debit", amountMinor: 500_000, currency: "NGN" },
          { account: "provider_earnings", ownerKey: `provider:${prov.providerId}`, direction: "credit", amountMinor: 500_000, currency: "NGN" },
        ],
      });
  });

    step("2. Banks from Paystack");
    const banks = await call("GET", "/providers/banks?currency=NGN", { token: prov.token });
    expect(banks.status === 200, `banks ${banks.status} ${banks.text}`);
    console.log(`${banks.json.banks.length} banks. First 12:`);
    for (const b of banks.json.banks.slice(0, 12)) console.log(`  ${b.code}  ${b.name}`);
    console.log("\nPaystack TEST mode rejects made-up accounts. Their documented test transfer account is:");
    console.log("  Zenith Bank   bank code 057   account number 0000000000");
    console.log("(source: paystack.com/docs/payments/test-payments, 'Bank accounts'). Press Enter to use it.");
    const bankCode = (await rl.question("Bank code [057]: ")).trim() || "057";
    const accountNumber = (await rl.question("Account number [0000000000]: ")).trim() || "0000000000";

    step("3. Resolve the account through Paystack and save it");
    const acct = await call("PUT", "/providers/me/payout-account", { body: { bankCode, accountNumber, currency: "NGN" }, token: prov.token, key: k("acct") });
    if (acct.status !== 200) {
      console.error(`Could not save the account: ${acct.status} ${acct.text}`);
      console.error("The message says which Paystack step failed (Account check = bank/resolve, Creating the payout recipient = transferrecipient). Try the Zenith test account above.");
      return;
    }
    console.log(`Account name from the bank: ${acct.json.payoutAccount.accountName} (last 4: ${acct.json.payoutAccount.accountLast4})`);

    step("4. Request a 1,000 NGN payout (reserves earnings; nothing is sent yet)");
    const req = await call("POST", "/providers/me/payouts", { body: { amountMinor: 100_000, currency: "NGN" }, token: prov.token, key: k("req") });
    expect(req.status === 201, `request ${req.status} ${req.text}`);
    const id = req.json.payout.id as string;
    console.log(`payout ${id} is ${req.json.payout.state}`);

    step("5. Admin approves: this is the moment Paystack is asked to send money");
    const ap = await call("POST", `/admin/payouts/${id}/approve`, { body: {}, token: admin.token });
    console.log(`approve -> HTTP ${ap.status}: state=${ap.json?.payout?.state} outcome=${ap.json?.outcome} ${ap.status !== 200 ? ap.text : ""}`);

    if (ap.json?.payout?.state === "processing") {
      console.log("Polling Paystack every 5 seconds for up to 2 minutes...");
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        const v = await call("POST", `/admin/payouts/${id}/verify`, { body: {}, token: admin.token });
        console.log(`  verify -> HTTP ${v.status}, gateway=${v.json?.gatewayStatus}, state=${v.json?.payout?.state}`);
        if (v.json?.payout?.state === "paid" || v.json?.payout?.state === "failed") break;
      }
    }

    step("6. Result");
    const bal = await call("GET", "/providers/me/balance?currency=NGN", { token: prov.token });
    console.log("balance:", JSON.stringify(bal.json.balance), " (minor units; 100 = 1 NGN)");
    const list = await call("GET", "/providers/me/payouts", { token: prov.token });
    const p = list.json.payouts.find((x: any) => x.id === id);
    console.log(`payout state: ${p?.state}${p?.failureReason ? `  reason: ${p.failureReason}` : ""}`);
    if (p?.state === "paid") console.log("\nLIVE PAYOUT PASSED (Paystack test mode). Record it in docs/CHANGELOG.md.");
    else {
      console.log("\nNot paid. Common test-mode causes (settings, not code):");
      console.log(" - Paystack dashboard > Settings > Preferences: untick 'Confirm transfers before sending' (OTP). With it on, a transfer waits for an OTP we cannot give.");
      console.log(" - Paystack says test transfers always succeed, so a failure here is about the account/settings, not about money.");
      console.log(" - transfers may need to be enabled for your business/country");
      console.log("A failed payout returns the earnings automatically; check the balance above.");
    }
  } finally {
    rl.close();
    await cleanupTestUsers(LIKE);
    await queryClient.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
