import "dotenv/config";
import readline from "node:readline/promises";
import { db, queryClient } from "../db/client";
import { accountBalance } from "../payments/ledger";
import { call, cleanupTestUsers, createProject, expect, registerProvider, registerUser } from "../api/test-helpers";

// LIVE TEST against Paystack TEST mode, run on localhost: no deployment, no webhook, no real money.
//   1. PAYSTACK_SECRET_KEY=sk_test_... in .env      2. npm run live:paystack
// It builds a project with an awarded provider and one NGN 5,000 milestone, starts a REAL Paystack payment, waits for
// you to pay with a Paystack TEST card in the browser, then verifies it through the API, approves and releases the
// milestone and prints the ledger. Safe to repeat: it refuses any key that is not a test key.

const LIKE = "livetest-%@example.com"; // Paystack needs a syntactically valid email; example.com is reserved for examples
const stamp = Date.now().toString(36);
const k = (n: string) => `${n}-${stamp}`;
const AMOUNT_MINOR = 500_000; // 5,000.00 NGN

const key = process.env.PAYSTACK_SECRET_KEY?.trim();
if (!key) { console.error("PAYSTACK_SECRET_KEY is not set in .env (use your Paystack TEST secret key, sk_test_...)"); process.exit(1); }
if (!key.startsWith("sk_test_")) { console.error("Refusing to run: this script only accepts a TEST key (sk_test_...)."); process.exit(1); }
process.env.PAYMENTS_PROVIDER = "paystack";

const step = (s: string) => console.log(`\n== ${s}`);

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await cleanupTestUsers(LIKE); // leftovers from an earlier aborted run

    step("1. Setting up owner, provider, project, awarded task, one milestone");
    const owner = await registerUser(`livetest-${stamp}-owner@example.com`);
    const prov = await registerProvider(`livetest-${stamp}-prov@example.com`, `lt-${stamp}`);
    const proj = await createProject(owner.token, `lt-${stamp}`, "Live Paystack test");
    expect((await call("POST", `/tasks/${proj.taskId}/transition`, { body: { to: "ready" }, token: owner.token, key: k("ready") })).status === 200, "task ready");

    const inv = await call("POST", `/tasks/${proj.taskId}/invitations`, { body: { providerProfileId: prov.providerId }, token: owner.token, key: k("inv") });
    expect(inv.status === 201, `invite ${inv.status} ${inv.text}`);
    const q = await call("POST", `/tasks/${proj.taskId}/quotes`, {
      body: { currency: "NGN", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), lines: [{ kind: "labour", description: "Work", quantity: 1, unitPriceMinor: 900_000 }] },
      token: prov.token, key: k("q"),
    });
    expect(q.status === 201, `quote ${q.status} ${q.text}`);
    expect((await call("POST", `/quotes/${q.json.quote.id}/submit`, { body: {}, token: prov.token, key: k("qs") })).status === 200, "submit quote");
    const acc = await call("POST", `/quotes/${q.json.quote.id}/accept`, { body: {}, token: owner.token, key: k("qa") });
    expect(acc.status === 200, `accept quote ${acc.status} ${acc.text}`);
    const assignmentId = acc.json.assignment.id as string;
    expect((await call("POST", `/assignments/${assignmentId}/accept`, { body: {}, token: prov.token, key: k("aa") })).status === 200, "accept assignment");
    const ms = await call("POST", `/projects/${proj.projectId}/milestones`, {
      body: { title: "Live test milestone", amountMinor: AMOUNT_MINOR, currency: "NGN", assignmentId }, token: owner.token, key: k("ms"),
    });
    expect(ms.status === 201, `milestone ${ms.status} ${ms.text}`);
    const milestoneId = ms.json.milestone.id as string;
    console.log("setup ok");

    step("2. Starting a REAL Paystack payment (test mode)");
    const pay = await call("POST", `/milestones/${milestoneId}/payments`, { body: {}, token: owner.token, key: k("pay") });
    if (pay.status !== 201) {
      console.error(`Payment was not created: ${pay.status} ${pay.text}`);
      console.error("If this is payment_provider_error, the message is Paystack's own (bad key, currency not enabled, invalid email...).");
      return;
    }
    const paymentId = pay.json.payment.id as string;
    console.log(`payment ${paymentId} is pending. Open this URL in your phone browser and pay with a Paystack TEST card:\n`);
    console.log(pay.json.checkoutUrl);
    console.log("\n(In Termux you can long-press to copy, or run: termux-open-url \"<url>\" if termux-api is installed.)");

    step("3. Verify through the API once you have paid");
    let secured = false;
    console.log("\nWaiting for you to pay. Checking Paystack every 5 seconds for up to 5 minutes (Ctrl+C to stop)...");
    const deadline = Date.now() + 5 * 60_000;
    while (!secured && Date.now() < deadline) {
      const v = await call("POST", `/payments/${paymentId}/verify`, { token: owner.token });
      console.log(`  verify -> HTTP ${v.status}, outcome=${v.json?.outcome}, providerStatus=${v.json?.providerStatus}, state=${v.json?.payment?.state}`);
      secured = v.status === 200 && v.json?.outcome === "secured";
      if (v.json?.outcome === "mismatch") { console.error("Gateway reported a different amount/currency: payment NOT secured (this is the safety check working)."); break; }
      if (!secured) await new Promise((r) => setTimeout(r, 5000));
    }
    if (!secured) { console.log("\nNot secured. Nothing was released. Re-run when you have paid."); return; }
    console.log("SECURED: money confirmed by Paystack and recorded in the ledger.");

    step("4. Provider submits, owner approves, owner releases");
    expect((await call("POST", `/milestones/${milestoneId}/submit`, { body: {}, token: prov.token, key: k("sub") })).status === 200, "provider submits");
    expect((await call("POST", `/milestones/${milestoneId}/approve`, { body: {}, token: owner.token, key: k("app") })).status === 200, "owner approves");
    const rel = await call("POST", `/milestones/${milestoneId}/release`, { body: {}, token: owner.token, key: k("rel") });
    expect(rel.status === 200, `release ${rel.status} ${rel.text}`);
    console.log("release:", JSON.stringify(rel.json.release));

    step("5. Ledger");
    const earn = await accountBalance(db, "provider_earnings", `provider:${prov.providerId}`, "NGN");
    const held = await accountBalance(db, "protected_funds", `project:${proj.projectId}`, "NGN");
    console.log(`provider earnings: ${earn}  | still protected: ${held}  | platform fee: ${rel.json.release.feeMinor}  (minor units; 100 = 1 NGN)`);
    console.log("\nLIVE TEST PASSED (Paystack test mode). Record it in docs/CHANGELOG.md.");
  } finally {
    rl.close();
    await cleanupTestUsers(LIKE);
    await queryClient.end();
  }
}
main().catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; });
