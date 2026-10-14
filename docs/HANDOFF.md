# HANDOFF — read this first

> Any AI or developer picking this project up: read this file, then `DECISIONS.md`,
> `NEXT_STEPS.md`, and the latest `CHANGELOG.md` entries. Keep all four updated as you work.
> Do not trust this file over the code: when they disagree, read the code and fix this file.

## What this project is
A global, AI-assisted labour / services / project-coordination platform. Requirements live in the PRD
(v2.0, Aug 2026, 172 sections). The owner holds the PDF; copy it to `docs/PRD.pdf` so it travels with the code.
Section numbers in code comments ("PRD §135") refer to it.
Core idea: one configurable project engine (request -> project -> tasks -> quotes -> assignment ->
evidence -> milestones -> changes -> payments -> completion -> aftercare). AI is optional and is NEVER
the system of record (PRD §20, §171).

## Owner and environment
- Owner: Azeez, fullstack developer. Works on Android in Termux. Commands must be short, copy-pasteable,
  and tolerant of flaky networks (npm registry timed out once; retry with higher fetch-timeout).
- Phone runtime: Node v26.3.1. Claude's sandbox has NO network and NO node_modules, so code written by
  Claude is not executed by Claude: the owner runs `typecheck` and tests, then reports output.
- Hosting plan: API on Vercel first, VPS later. Keep code portable.
- Database: Supabase Postgres used as PLAIN Postgres (no Supabase Auth/RLS policies/edge functions).
  Region eu-west-1. Free tier pauses after ~7 days idle, 500 MB: development only.

## Owner's working preferences (apply them)
- Complete, working code grounded in the real codebase; no placeholders, no invented APIs.
- Read (`cat`) existing files before editing; surgical changes over rewrites.
- Deliver changes as terminal commands (heredocs / python edits), NOT zips; the owner pastes the output back.
- Proactively report bugs found beyond the stated scope. Direct, forward momentum, few questions.
- Never ask for or accept secrets (DB passwords, connection strings) in chat.

## Current status
BUILT and verified on the live Supabase DB by the owner (session 2 output):
- Schema (Drizzle): domain tables from sessions 1-2 plus `user_credentials` and `sessions`.
  Migrations 0000 (initial), 0001 (FK `project_baselines_cr_fk`), 0002 (sessions + user_credentials). All applied.
- `sql/guards.sql` (append-only, immutability, ledger balance triggers) applied.
- `npm run db:lockdown`: enables RLS on every public table and revokes `anon`/`authenticated` grants so
  Supabase's REST Data API cannot touch our tables. Reported 0 tables without RLS, 0 grants.
- Auth API on Hono: POST /auth/register, /auth/login, /auth/logout, GET /me, GET /health.
  Passwords: argon2id via `hash-wasm` (WASM, no native build). Sessions: opaque 32-byte token, only its
  SHA-256 is stored, 30-day TTL, revocable. Same 401 for unknown email vs wrong password (dummy hash burn).
  Suspended users cannot log in and existing sessions stop working. 12/12 `npm run test:auth` tests passed.
- `npm run db:test-guards`: 19 DB tests covering append-only, quote/message freeze, ledger rules, partial
  unique index, CHECK constraints, baseline FK. (Owner has not pasted its output in chat: re-run and record.)

VERIFIED IN SESSION 3 (owner's terminal output, all green):
- `npm run typecheck` clean. `npm run test:auth` 12/12. `npm run test:ratelimit` 3/3.
  `npm run db:test-guards` 19/19 (append-only, quote/line freeze, message immutability, ledger currency +
  balance + idempotency, one-live-assignment index, reviews/payments/users/evidence/dependency CHECKs, baseline FK).
- Migration `drizzle/0003_curious_norrin_radd.sql` (adds `rate_limit_hits`) generated and applied.
  `db:lockdown`: 0 tables without RLS, 0 anon/authenticated grants.
- DB-backed rate limiting (`src/auth/rate-limit.ts`): register 10/10min per IP; login 30/10min per IP and
  10/10min per email. 429 + Retry-After. `test:auth` runs with `RATE_LIMIT_DISABLED=1`; `test:ratelimit` with it on.
- CORS opt-in via `CORS_ORIGINS` (written; no automated test yet).
- The `VAR=1 cmd` script prefix works in Termux/bash/sh; it would not work on Windows cmd.

VERIFIED (18/18 test:requests) from session 4 (see CHANGELOG, DECISIONS D20-D25): idempotency helper, activity helper, authz helpers,
POST/GET /requests, POST /requests/:id/convert, GET /projects/:id, `npm run test:requests`.

WRITTEN IN SESSION 5, NOT YET RUN: tasks (create, get, dependencies with cycle check, manual transitions), `npm run test:tasks`.

VERIFIED IN SESSION 6 (owner's terminal output): migration `0004_lyrical_hedge_knight.sql` (task_invitations) applied; `db:lockdown` 56 tables, 0 without RLS,
0 grants; `typecheck` clean; `test:tasks` 10/10; `test:quotes` 17/17. Built and verified: provider profile endpoints, task invitations, quotes (create / edit
draft / submit / request-revision / revise / withdraw / reject / accept), provider-only visibility (PRD §34). See DECISIONS D28-D34.
VERIFIED IN SESSION 7 (owner's terminal output): typecheck clean; test:auth 12/12, test:ratelimit 3/3, test:requests 18/18, test:tasks 10/10,
test:quotes 17/17, test:assignments 8/8, db:test-guards 19/19. Built: provider assignment accept/reject/list (D35-D36).
VERIFIED IN SESSION 7 (owner's output of `npm run test:all`): test:milestones 10/10 on top of the suites above. Built: milestones and evidence
metadata for tasks and milestones (D37-D40).
WRITTEN IN SESSION 7, NOT YET RUN: task work lifecycle start/submit/request-changes/approve/complete (D41-D44), `npm run test:task-work`.

VERIFIED IN SESSION 9 (owner's terminal output): `npm run test:payments` 12/12 with `PAYMENTS_PROVIDER=sandbox` (create payment, verify, webhook with
signature, failed payment retry, verify-vs-webhook race capturing once, release only for approved work, ledger balanced, activity events). One WARN:
test cleanup could not delete projects because webhook-written activity events have a NULL actor; fixed in session 9 (src/api/test-helpers.ts).
BUILT (D45-D48): payment provider interface, sandbox + Paystack adapters (collection only), POST /milestones/:id/payments, POST /payments/:id/verify,
GET /payments/:id, POST /webhooks/:provider, POST /milestones/:id/release (ledger: protected_funds -> provider_earnings + platform_fees).

PAYMENTS: WHAT IS AND IS NOT DONE (session 9 review, from reading the code)
- The Paystack adapter has NEVER talked to real Paystack: every payments test uses the sandbox provider. Session 9 added `npm run test:paystack`
  (adapter vs a local fake Paystack server: request shape, status mapping, errors, signature). It still does not prove real Paystack behaviour:
  run the live test-mode checklist in NEXT_STEPS Step 3b before any real money.
- GAP (bug-class): a `pending` payment never expires. Paystack "abandoned" is mapped to pending, and creating a payment is refused while any non-failed
  payment exists for the milestone, so a customer who closes the checkout page can leave the milestone unpayable. Fixing it needs a policy for
  money that arrives AFTER expiry (the webhook currently ignores payments that are not pending). Do not just flip stale payments to failed.
- GAP: amount/currency mismatch leaves the payment pending and only writes a `payment.amount_mismatch` activity event: nobody is alerted.
- GAP: Paystack status "reversed" is treated as pending; refund and dispute webhooks (charge.dispute.*) are ignored.
- NOT BUILT (D49): payouts (Paystack Transfers, provider bank details, PRD §125 compliance), refunds, dispute holds, reconciliation.
  Provider earnings stay in the ledger until payouts exist.
- The gateway HTTP call runs inside the DB transaction, holding the milestone row lock for up to its 15 s timeout.
- The webhook needs a public HTTPS URL (Vercel deploy, Step 2, or a tunnel). Without it, `POST /payments/:id/verify` still secures a paid payment.

VERIFIED IN SESSION 11 (owner's output): typecheck clean (API + web), `test:threads` 5/5. Built: provider trades, invite screen, manager quotes screen, per-provider message thread, provider quote form (D59-D63).
SESSION 11 (second half): change requests, reviews and in-app notifications built; hard-coded market/currency removed; full PRD status table in docs/PRD_COVERAGE.md. NOT YET RUN by the owner: `npm run test:changes`.
SESSION 12: evidence files (upload-url, verified confirm, signed links), project timeline endpoint + panel, task work screen. VERIFIED by the owner: `test:work` 5/5 (with test:changes 9/9, test:threads 5/5). Live Supabase upload and the screens untested.
NOT BUILT: check-in/arrival, file
storage for evidence (upload + signed URLs), push/email/SMS notifications (in-app inbox exists, D72), translation/AI, background jobs (incl. quote expiry), CI, Vercel entry file, session cleanup job.

## Open questions / risks
1. SHARED DATABASE (CONFIRMED): the 3 non-platform public tables are `admin_profiles`, `vehicle_images`, `vehicles`
   (another app, apparently the owner's dealership project). This Supabase project ("primestones") is shared.
   `db:lockdown` enabled RLS on ALL public tables and revoked `anon`/`authenticated` grants on ALL of them, including
   those three, so the other app may have lost access if it uses supabase-js with the anon key. Owner must check it
   and, if broken, restore access (see NEXT_STEPS Step 0). DECISION PENDING: move this platform to its own Supabase
   project (recommended). Until then do not run db:lockdown again and do not drop/alter tables not in docs/SCHEMA.md.
2. `npm audit` reported 5 vulnerabilities (4 moderate, 1 high) at first install; not reviewed.
3. Vercel entry written in session 9 (`src/index.ts`, `vercel.json`, `docs/DEPLOY.md`) but NEVER deployed. The Node/VPS entry is now `src/node-server.ts`;
   the old `src/server.ts` must be deleted (Vercel picks its entry by the names app/index/server).
4. In-flight: client IP for rate limiting comes from `X-Forwarded-For`; safe only behind Vercel or a proxy.
5. Append-only triggers block deleting projects that have evidence/ledger rows. Retention/erasure
   process (PRD §130-131) is undecided.
6. Expired/revoked sessions are never deleted yet.
7. Every migration that creates tables must be followed by `npm run db:lockdown` (and `db:guards` if guarded tables changed).
8. Deleting projects/users that have quotes is blocked by FKs without cascade (`quotes.project_id`, `assignments.quote_id`,
   `provider_profiles.user_id`) and by the quote freeze triggers. Only the test cleanup (which disables the triggers inside one
   transaction) can do it today. Any erasure/retention flow (PRD §130-131) must be designed around this.
9. The AI session that wrote session 6 saw `.env` inside the uploaded zip again. Rotate the DB password and zip with `-x "labour-platform/.env"`.

## How to run
```bash
npm install
cp .env.example .env     # fill DATABASE_URL (pooled, 6543) and DIRECT_URL (session pooler, 5432)
npm run typecheck
npm run db:generate      # only after schema edits; commit drizzle/
npm run db:migrate
npm run db:guards
npm run db:lockdown
npm run db:seed
npm run db:test-guards
npm run test:auth
npm run test:ratelimit
npm run test:requests
npm run test:tasks
npm run test:quotes
npm run test:assignments
npm run test:milestones
npm run test:task-work    # or: npm run test:all
npm run dev              # API on http://localhost:8787
```
`.env` is never committed. DB password special characters must be URL-encoded.

## Zipping the repo to share it
`cd ..` then `zip -r labour-platform.zip labour-platform -x "labour-platform/node_modules/*" "labour-platform/.git/*" "labour-platform/.env"`.
Never include `.env` (live DB credentials).

## Conventions that must not be broken
- Money = integer minor units + explicit currency column. No floats.
- Service identity = `canonical_key`; names only in translation tables.
- Ledger balances derived from `ledger_lines`; every entry balances per currency.
- Evidence, activity events, ledger entries/lines, baselines are append-only (DB-enforced).
- Payment state is separate from task/milestone state.
- Every consequential write is idempotent and emits an `activity_events` row in the same transaction.
- Authorization lives in the Node API (role + object level), never in Supabase RLS policies.
- Error body shape: `{ "error": { "code", "message", "details?" } }` via `err()` in `src/api/http.ts`.


## Session 10 summary (read this first)
Collection verified live in Paystack TEST mode. Written but NOT RUN (owner must run, see NEXT_STEPS Step 3c): abandoned checkout + late-success suspense,
gateway alert logging, payouts (provider payout account, reserve, admin approve, two-phase transfer, webhooks, verify), admin attention/payout queues,
reconciliation. A schema migration is required. Money-out code was written without being able to call Paystack's Transfers API: treat
`src/payments/paystack.ts` payout methods as UNVERIFIED until `npm run live:payout` passes. Before any real money: docs/LAUNCH_CHECKLIST.md.
Do NOT share `.env` (it was shared three times); zip with `-x "labour-platform/.env"`.

VERIFIED IN SESSION 11 (owner's output): `npm run test:changes` 9/9 (changes, reviews, notifications) and `test:threads` 5/5, typecheck clean. Screens still to be walked by hand.
