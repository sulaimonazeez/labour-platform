import "dotenv/config";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// Run BEFORE pushing/deploying:  npm run deploy:check
// Checks the local repo and .env for the mistakes that matter. Prints NAMES only, never secret values.
let fails = 0;
const ok = (m: string) => console.log(`ok    ${m}`);
const warn = (m: string) => console.log(`WARN  ${m}`);
const fail = (m: string) => { fails++; console.log(`FAIL  ${m}`); };
const sh = (cmd: string) => { try { execSync(cmd, { stdio: "ignore" }); return true; } catch { return false; } };

// Secrets must never reach git
if (!existsSync(".git")) warn("not a git repository yet (run `git init` before the first push)");
else {
  if (sh("git ls-files --error-unmatch .env")) fail(".env is TRACKED by git: run `git rm --cached .env` and commit, then ROTATE every secret in it");
  else if (sh("git check-ignore -q .env")) ok(".env is ignored by git");
  else fail(".env is not ignored: add `.env` to .gitignore");
}

// Files the deploy needs / must not have
if (existsSync("src/server.ts")) fail("src/server.ts still exists (old entry): `rm -f src/server.ts`");
else ok("old src/server.ts is gone");
for (const f of ["src/index.ts", "vercel.json"]) existsSync(f) ? ok(`${f} present`) : fail(`${f} is missing`);

// Environment (names only)
const env = process.env;
env.DATABASE_URL ? ok("DATABASE_URL set") : fail("DATABASE_URL is not set");
if (env.DATABASE_URL && !/:6543\b/.test(env.DATABASE_URL)) warn("DATABASE_URL is not on port 6543: Vercel should use the TRANSACTION pooler");
env.DIRECT_URL ? ok("DIRECT_URL set (local only: migrations and test cleanup; do NOT add it to Vercel)") : warn("DIRECT_URL not set: migrations and test cleanup will not work from here");

const key = env.PAYSTACK_SECRET_KEY?.trim();
if (!key) fail("PAYSTACK_SECRET_KEY is not set");
else if (key.startsWith("sk_live_")) fail("PAYSTACK_SECRET_KEY is a LIVE key: not allowed until docs/LAUNCH_CHECKLIST.md section A is closed in writing. Use sk_test_.");
else if (key.startsWith("sk_test_")) ok("PAYSTACK_SECRET_KEY is a TEST key");
else fail("PAYSTACK_SECRET_KEY does not look like a Paystack secret key (sk_test_...)");
if (env.PAYSTACK_PUBLIC_KEY) warn("PAYSTACK_PUBLIC_KEY is set but unused by the server: delete it (and never mix pk_live with sk_test)");
if (env.PAYMENTS_PROVIDER && env.PAYMENTS_PROVIDER !== "paystack") warn(`PAYMENTS_PROVIDER is "${env.PAYMENTS_PROVIDER}" locally; set it to paystack in Vercel`);
env.PLATFORM_ADMIN_USER_IDS ? ok("PLATFORM_ADMIN_USER_IDS set") : warn("PLATFORM_ADMIN_USER_IDS not set: nobody can use /admin/* (expected until you have registered your admin user on the deployed API)");

console.log("\nSet these in Vercel (Production), values from your .env except where noted:");
console.log("  DATABASE_URL          (transaction pooler, port 6543)");
console.log("  PAYMENTS_PROVIDER     paystack");
console.log("  PAYSTACK_SECRET_KEY   sk_test_...");
console.log("  PLATFORM_ADMIN_USER_IDS  <your admin user id, after you register on the deployed API>");
console.log("  (optional) PAYMENTS_CALLBACK_URL, CORS_ORIGINS, PAYMENT_PENDING_TTL_MINUTES, PAYOUT_MIN_MINOR, PAYOUT_ACCOUNT_COOLDOWN_HOURS");

console.log(fails ? `\n${fails} problem(s) to fix before deploying.` : "\nReady to deploy (test mode). Remember: typecheck + test:all must be green.");
process.exit(fails ? 1 : 0);
