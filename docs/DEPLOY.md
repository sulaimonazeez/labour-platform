# DEPLOY (Vercel, from a phone) — written session 9, NOT yet followed end to end

Deploying is OPTIONAL and can wait: the whole API runs on localhost (`npm run dev`), and `npm run live:paystack` tests real Paystack without a deployment.
Only the Paystack WEBHOOK needs a public HTTPS URL (and `POST /payments/:id/verify` secures payments without it).

Why it works: Vercel detects a Hono app from a file named `src/index.ts` that imports `hono` and default-exports the app (Vercel docs, "Hono on Vercel").
This repo's `src/index.ts` does that. `src/node-server.ts` is only for local/VPS. `vercel.json` pins region `dub1` next to the database.

## 0. Before deploying
```bash
cd ~/labour-platform
rm -f src/server.ts            # the old Node entry (renamed to src/node-server.ts)
npm run typecheck && npm run test:entry
npm run deploy:check           # checks .env is not tracked, a TEST key is used, required files exist (prints names only)
```

## 1. Put the code on GitHub (private repo)
- Make sure `.env` is NOT tracked: `git check-ignore .env` should print `.env`.
- Create an empty PRIVATE repository on github.com, then:
```bash
git init   # skip if already a repo
git add -A && git status           # read the list: no .env, no node_modules
git commit -m "labour platform"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
(GitHub asks for a personal access token as the password when pushing from Termux.)

## 2. Create the Vercel project
vercel.com -> Add New -> Project -> import the repo. Leave build settings as detected (Framework: Hono). Before the first deploy, add Environment Variables (Production):

| Name | Value |
|---|---|
| `DATABASE_URL` | Supabase TRANSACTION pooler string (port 6543). Required. |
| `PAYMENTS_PROVIDER` | `paystack` |
| `PAYSTACK_SECRET_KEY` | your Paystack TEST key (`sk_test_...`) until the live checklist is done |
| `PAYMENTS_CALLBACK_URL` | where Paystack sends the customer back (optional until you have a front end) |
| `CORS_ORIGINS` | comma-separated front-end origins (optional until you have a front end) |
| `PLATFORM_ADMIN_USER_IDS` | comma-separated user ids allowed to use `/admin/*` (approve payouts, attention queue). Without it nobody is an admin. |
| `PAYMENT_PENDING_TTL_MINUTES` | optional, default 30: when an unpaid checkout counts as abandoned |
| `PAYOUT_MIN_MINOR` | optional, default 10000 (NGN 100.00): smallest payout |
| `PAYOUT_ACCOUNT_COOLDOWN_HOURS` | optional, default 24: payout pause after a provider changes bank account |

Do NOT add `DIRECT_URL` to Vercel (only migrations use it, from your phone/CI).
Vercel sets `NODE_ENV=production`, and in production the sandbox payment provider is refused on purpose: without `PAYMENTS_PROVIDER=paystack` and a key, payment routes answer 503.

## 3. Check it
`npm run smoke -- https://<your-project>.vercel.app` runs the checks below automatically (it registers one throwaway user on that database; test deployments only).
By hand:
Open `https://<your-project>.vercel.app/health` -> `{"ok":true}`. Then register a user (`POST /auth/register`) and call `GET /me` with the token.
If a request shows a Vercel login page instead of JSON, you are hitting a protected preview URL: use the production domain.

## 4. Paystack webhook (test mode)
Paystack dashboard (test mode) -> Settings -> API Keys & Webhooks -> set the webhook URL to `https://<your-production-domain>/webhooks/paystack`.
Then follow the live checklist in `docs/NEXT_STEPS.md` Step 3b. `POST /payments/:id/verify` also secures a paid payment without the webhook.

## 4b. Webhook events
The same URL receives everything. In the Paystack dashboard make sure the events you want are delivered: `charge.success` (needed), `transfer.success`, `transfer.failed`,
`transfer.reversed` (needed for payouts), and refund/dispute events (logged for a human, see D54). Nothing is applied from a webhook body without asking Paystack first.

## 5. Migrations are NOT run by Vercel
Run `npm run db:migrate && npm run db:guards && npm run db:lockdown` from your phone (uses DIRECT_URL in your local `.env`) before deploying code that needs new tables.

## Known unknowns (verify on the first deploy)
- Rate limiting reads `X-Forwarded-For`; confirm in Vercel's docs that clients cannot spoof it before relying on per-IP limits.
- Function region `dub1` is a choice; remove or change `vercel.json` if the database moves.
- Free Supabase pauses after a week idle; the first request after a pause fails until the project is resumed.

## 6. The web app (second Vercel project)
Import the SAME repo again as a new project. Set Root Directory to `web` (Framework: Vite). Add env var `VITE_API_URL` = the API project's production URL (no trailing slash).
`web/vercel.json` makes client-side routes work on reload. After it is deployed, go back to the API project and set `CORS_ORIGINS` = the web URL (exact origin, no trailing slash)
and `PAYMENTS_CALLBACK_URL` = `<web URL>/pay/return`, then redeploy the API (env changes need a redeploy).
