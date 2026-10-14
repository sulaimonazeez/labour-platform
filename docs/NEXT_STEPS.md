# NEXT STEPS (ordered; move finished items to CHANGELOG)

## Step 0 — shared database (grants restored and verified in session 4; dealership site check + new project still open)
- [ ] Restore the other app's access. FINDING: `vehicles`, `vehicle_images`, `admin_profiles` have RLS policies
  (public read + admin write), so RLS was intended on; `db:lockdown` only removed their grants. Run in the SQL Editor:
  `grant all on public.vehicles, public.vehicle_images, public.admin_profiles to anon, authenticated;`
  `alter default privileges in schema public grant all on tables to anon, authenticated;`
  Then verify with: `select grantee, table_name, privilege_type from information_schema.role_table_grants
  where table_schema='public' and table_name in ('vehicles','vehicle_images','admin_profiles')
  and grantee in ('anon','authenticated');` (expect rows) and test the dealership site (public listing + admin login).
  Do NOT disable RLS on those tables.
- [ ] Create a NEW Supabase project dedicated to this platform. Then in `.env` set the new DATABASE_URL / DIRECT_URL and run
  `npm run db:migrate && npm run db:guards && npm run db:lockdown && npm run db:seed` and re-run the three test suites.
  Afterwards (only after the other app is confirmed healthy) remove this platform's tables from the old project
  with a reviewed, explicit drop script; do not drop anything by pattern.
- [x] `src/db/apply-lockdown.ts` now acts only on this platform's own tables (written, needs a first run + typecheck).
- [ ] Review `npm audit`; do not run `npm audit fix --force` blindly.
- [ ] Copy the PRD PDF to `docs/PRD.pdf`; commit `drizzle/` (includes 0003) and `docs/`.

## Step 0a — run the session 6 code (quotes) FIRST
- [ ] Rotate the Supabase DB password again (`.env` was in the session 6 zip too); update local `.env`.
- [x] (done, session 6) `npm run db:generate` (expect one new migration `drizzle/0004_*.sql` creating `task_invitations`; read it, it must contain
  only that table, its two FKs/PK and its index), then `npm run db:migrate && npm run db:lockdown` (expect "56 of our tables defined, 0 without RLS").
  Commit `drizzle/`.
- [x] (done, clean) `npm run typecheck`. Likeliest trouble spots: drizzle `.for("update")` typing in `src/api/quote-routes.ts` (`loadQuote`), `z.int()` /
  `z.iso.datetime` / `.transform().refine()` in the zod 4 schemas, `Executor` accepting `tx`. Fix the exact line reported; do not rewrite.
- [x] test:tasks 10/10 and test:quotes 17/17 pass. STILL TO RUN: `test:auth`, `test:ratelimit`, `test:requests`, `db:test-guards`. Paste all output.
  `test:quotes` is the first run of ~40 new assertions; expect to fix a few. If cleanup warns, check `DIRECT_URL` and read D34.

## Step 0b — run the session 4 code
- [ ] Rotate the Supabase DB password (the old `.env` was inside an uploaded zip); update local `.env`.
- [ ] `npm run typecheck` (likeliest trouble spot: the `Executor` type in `src/db/types.ts`, D22).
- [x] `npm run typecheck` and `test:requests` (18/18) passed.
- [ ] `npm run typecheck && npm run test:tasks`, then `test:auth`, `test:ratelimit`, `db:test-guards` once more. Paste output.

## Step 1 — core API, first vertical slice
STATUS: items 1-4 done and verified (18/18). Items 5 and 6 verified in session 6 (test:tasks 10/10, test:quotes 17/17).
Items 6b, 7, 8 not started.
Read the real code before starting. Conventions: Hono routers in `src/api/*-routes.ts`, zod validation,
`requireAuth`, `err()` bodies, transactions via `db.transaction`.
Build in this order, each with tests in the style of `src/api/test-auth.ts`:
1. `src/lib/idempotency.ts` over `idempotency_keys` (scope + key + request hash; replay returns stored
   response; same key with a different body returns 422).
2. `src/lib/activity.ts` helper writing `activity_events` inside the caller's transaction.
3. `src/authz/` project role checks from `project_members`; object-level checks (never trust ids from the client).
4. Requests: POST /requests, GET /requests/:id, POST /requests/:id/convert (creates project + owner membership
   + default stage/task).
5. Tasks: POST /projects/:id/tasks, POST /tasks/:id/transition using `assertTransition` from
   `src/engine/state-machines.ts`; add dependency cycle check when creating `task_dependencies`.
6. Quotes: DONE and verified (session 6), see DECISIONS D28-D33 and README endpoint table.
6b. (WRITTEN session 7, run `npm run typecheck && npm run test:assignments`) Assignment response: `POST /assignments/:id/accept` and `/reject` by the provider. Accept: assignment offered -> accepted, task
   assigned -> accepted (legal in `TASK_TRANSITIONS`), activity event. Reject: assignment -> rejected, task assigned -> offered, quote back to
   `submitted`?? (DECIDE with the owner: reopen bidding or end the quote), provider membership handling. Then task start (accepted -> in_progress)
   belongs with check-in/evidence. Add `GET /assignments` for the provider workspace (PRD §65).
7. Milestones: WRITTEN session 7 (create, list, get, submit, approve, request-changes), run `npm run test:milestones`.
8. Evidence metadata endpoints: WRITTEN session 7 (tasks + milestones). Storage upload (Supabase Storage vs S3-compatible, signed URLs) still to decide.
Acceptance for each endpoint: transactional, idempotent via `Idempotency-Key`, object-level authorized,
emits an activity event, has automated tests. After any new table: `db:generate`, `db:migrate`, `db:lockdown`.

## Step 2 — Vercel entry + deployment
- [x] Entry written (session 9): `src/index.ts`, `src/node-server.ts`, `vercel.json`, `npm run test:entry`; steps in `docs/DEPLOY.md`.
- [x] Owner deleted `src/server.ts`; typecheck clean; `test:entry` 5/5 (session 9).
- [ ] Owner: push to a PRIVATE GitHub repo (`.env` is gitignored), import it in Vercel, add the env vars from DEPLOY.md, deploy, check `/health`.
- [ ] Then the Paystack webhook live test (Step 3b) with `https://<your-domain>/webhooks/paystack`.
- Keep migrations on a trusted machine/CI (DIRECT_URL), never in serverless functions.

## Step 3 — payments and ledger service
`PaymentProvider` interface, sandbox adapter for tests, ledger posting functions (capture -> secure ->
release -> fee -> payout) with idempotency keys, payment transitions through `PAYMENT_TRANSITIONS`, webhook
skeleton. Choose the first real provider with the owner (Nigeria first).

## Step 3c — RUN ORDER after session 10 (owner, in this order)
1. Rotate the DB password + Paystack test secret key (the .env was shared). Delete `PAYSTACK_PUBLIC_KEY` from `.env`.
2. [x] DONE: unzip over the repo, `npm run typecheck`.
3. [x] DONE (0005 applied): `npm run db:generate && npm run db:migrate && npm run db:lockdown` (adds `provider_payout_accounts`, new `payouts` columns). Read the generated `drizzle/0005_*.sql` before migrating.
4. [x] DONE (all green, session 10): `npm run test:checkout && npm run test:payouts`, then `npm run test:all`.
5. [~] `npm run reconcile` verified against real Paystack. `npm run live:payout`: banks OK; re-run with the Zenith TEST account (057 / 0000000000), untick the OTP setting if asked.
6. Only then: `npm run deploy:check`, deploy (docs/DEPLOY.md), `npm run smoke -- <url>`, set the webhook, and work through docs/LAUNCH_CHECKLIST.md.

## Step 3b — finish payments (session 9 review; Step 3a is built and verified with the sandbox provider)
Order matters; do not skip the live test.
- [x] Owner ran `npm run test:paystack` and `npm run test:payments`: both 12/12, cleanup warning gone (session 9).
- [x] LOCALHOST LIVE TEST PASSED (owner, session 10). Original instructions: set `PAYSTACK_SECRET_KEY=sk_test_...` in `.env`, run `npm run live:paystack` (src/dev/live-paystack.ts: builds a project, starts a real
  Paystack test payment, waits while the owner pays with a Paystack TEST card, then verifies, approves, releases and prints the ledger; refuses non-test keys).
  No deployment and no webhook needed. Manual variant of the same test:
- [ ] LIVE TEST in Paystack TEST mode (no real money): get the test secret key from the Paystack dashboard; locally set
  `PAYMENTS_PROVIDER=paystack` and `PAYSTACK_SECRET_KEY=sk_test_...` in `.env`; run `npm run dev`; take a project to a pending milestone;
  `POST /milestones/:id/payments` and open `checkoutUrl`; pay with a test card from Paystack's test-mode documentation; then
  `POST /payments/:id/verify` and expect `outcome: "secured"`; approve and release the milestone; check the ledger. Record the result in CHANGELOG.
- [ ] Webhook live test (only this part needs a public URL, so it can wait): deploy (Step 2) or use a tunnel, then set `https://<host>/webhooks/paystack` in the Paystack dashboard.
- [x] Abandoned checkout BUILT (D53, session 10; NOT YET RUN: `npm run test:checkout`). Original brief: Needs a pending-payment TTL, a verify-before-expire step, and a rule for success arriving
  after expiry (record it and route to refund/manual review; never lose the money silently). Add tests.
- [x] Alert path BUILT as `GET /admin/attention` (D56; not yet run). Push notifications/email are still to do.
- [~] Refund/dispute/chargeback webhooks are LOGGED only (D54). Still to build: a refunds endpoint and automatic handling once real payloads are captured. (state machine already has refunded/partially_refunded/chargeback).
- [x] Payouts BUILT (D55-D57; NOT YET RUN: `npm run test:payouts`, then `npm run live:payout`). Original brief: provider bank details + verification, Paystack transfer recipients and transfers, payout state machine, transfer webhooks,
  PRD §125 payout compliance, idempotency on every transfer. Biggest remaining piece; money leaves the platform here, so test-mode first.
- [x] Reconciliation BUILT read-only (D58): `npm run reconcile`. Scheduling it (cron/CI) is still to do.
- [ ] Legal review before real money: "secured" is not regulated escrow (D46). See docs/LAUNCH_CHECKLIST.md for everything only a human can do.

## Step 4 — contextual chat API and notifications
Conversation per (context_type, context_id), participant-based access (PRD §34), `client_message_id`
idempotency, original text never overwritten. Translation hook left for Phase 2.

## Step 5 — housekeeping jobs and CI
Session cleanup (delete expired/revoked), `idempotency_keys` expiry (e.g. > 7 days), rate_limit_hits already self-prunes, GitHub Actions running typecheck + tests against a throwaway DB.

## Later phases (PRD §152-161)
Multilingual intelligence, AI project assistant, advanced marketplace, commerce and assets, business
operations, government programmes, market expansion, market intelligence.

## Session 7 additions
- [ ] Run `npm run test:all` and paste the output (this also re-runs the suites flagged "still to re-run" after session 6).
- [ ] Follow-up from D36: let a manager re-invite a provider whose invitation is `expired`.
- [ ] Next build: Step 1 item 7 (milestones) and item 8 (evidence metadata), then task start (accepted -> in_progress) with check-in.

## Session 7 (continued): what is next
- [ ] Run `npm run test:all`; paste the output.
- [x] Task start and completion: WRITTEN session 7 (D41-D44), run `npm run test:task-work`. Check-in/arrival (PRD §73) is still not built.
- [ ] Decide evidence file storage, then add signed upload/download URLs.
- [ ] Then Step 2 (Vercel entry) or Step 3 (payments + ledger, which unlocks milestone `funded`/`released`). Choose with the owner.

## After the task workflow
- [ ] Follow-ups found: set task `evidenceRequirements` on create/edit (D43); cancel a milestone (D44); re-invite an `expired` invitation (D36).
- [ ] Decide evidence file storage, then signed upload/download URLs.
- [ ] Step 3 (payments + ledger) unlocks milestone `funded`/`released`; Step 2 (Vercel entry) is independent. Choose with the owner.

## Step 4 — follow-ups from session 11 (reach-out path)
- [ ] Walk the flow by hand with two accounts (Find -> request -> ready -> invite -> message -> quote -> accept) and record the result in CHANGELOG.
- [ ] Mark invitations `viewed` when the provider opens one (PRD §95); today status stays `invited` until a quote exists.
- [ ] Quote revision screens (request-revision / revise) and an accept-then-assignment screen for the provider (assignments API exists, D35).
- [ ] Move the thread to task/quote chat contexts once assignments exist (D60); add translation provenance (PRD §29) in Phase 2.
- [ ] Replace 10 s polling (D62); strip GPS from photos before upload (INTAKE-6) still open.
- [ ] Taxonomy endpoint so the web stops mirroring categories (PRD §24); only 3 categories are seeded, so only those can be offered as trades.

## Step 5 — after session 11 (PRD alignment)
- [ ] Run `npm install && npm run typecheck && npm run test:changes && npm run test:threads`, then record the results in CHANGELOG. Then walk the screens by hand (two accounts).
- [ ] PRD Phase 1 still missing (see docs/PRD_COVERAGE.md): scheduling (§71), project updates, derived budget view (§56), taxonomy endpoint (§24).
- [ ] Change request chat (§31) and moving the pre-award thread to task/quote contexts (D60, D68). Change requests do not yet adjust milestones or payments (D67).
- [ ] Customer reputation (§93), minimum-group rules for any aggregate that crosses providers (§121).
- [ ] Push/email/SMS channels, quiet hours, channel preferences (§112-113); replace polling (D62, D72).
- [ ] Add a short "Session 11 summary" to HANDOFF when this step is verified.

## Step 6 — after session 12 (the work flow)
- [ ] `npm run typecheck && npm run test:work && npm run test:all`; record results in CHANGELOG. Then walk it by hand: provider starts, adds a photo, submits; owner approves, completes, reviews.
- [ ] Live test of evidence upload against the real Supabase bucket (D40, D74); until then only the in-memory driver has been exercised.
- [ ] Milestone screens: owner creates milestones, provider submits one, owner approves; then fund/release through payments (API exists, D44-D57).
- [ ] Provider check-in / arrival (PRD §73) and blockers/issues (§78); resumable uploads and offline capture (§110-111).
- [ ] Evidence requirements per task (D43): let the owner set how many photos a task needs when creating it.

## Session 13 additions
- [ ] Run `npm run typecheck && npm run test:money-views`, restart `npm run dev`, then walk the flow by hand with two accounts (steps in the session 13 message).
- [ ] BACKEND FIX (D-entry needed): refuse milestone submit/start from `pending` (code `milestone_not_funded`) and update the tests that rely on it. PRD §48.
- [ ] Provider earnings screen + payout account setup + payout request (APIs exist: /providers/me/balance, payout-account, payouts).
- [ ] Taxonomy endpoint (PRD §24) + fairer provider ordering than alphabetical (PRD §96).
