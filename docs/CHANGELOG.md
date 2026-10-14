# CHANGELOG / SESSION LOG
Append a new dated entry every working session: what changed, what was verified, what broke.
Newest entries at the bottom. Never delete old entries.

## 2026-10-06 — Session 1 (Claude)
- Reviewed PRD v2.0 (172 sections); agreed to build Phase 1 + 1A foundation first.
- Chose stack: Node.js/TypeScript, Drizzle + postgres-js, Supabase Postgres as plain Postgres,
  Vercel first then VPS (see DECISIONS D1-D4).
- Wrote the repo scaffold, 52-table schema, `sql/guards.sql`, state-machine tables, seed, README.
- Owner installed on Termux (first `npm install` timed out on the registry; retried successfully).
  `npm run typecheck` passed. `db:generate` produced `drizzle/0000_young_true_believers.sql`.
- First `db:migrate/guards/seed` failed only because `.env` held placeholder URLs; fixed by filling
  Supabase transaction-pooler (6543) and session-pooler (5432) strings.
- Migration, guards and seed then applied successfully. Postgres NOTICE messages (identifier
  truncation of one long FK name; "trigger does not exist, skipping" on first guard run) are harmless.
- Verified live in Supabase SQL Editor: append-only trigger blocks UPDATE on activity_events;
  unbalanced ledger entry is rejected at commit.
- Added handoff docs (this folder).
- Open: Hono/auth plan awaiting owner confirmation (DECISIONS D13); see HANDOFF "Open questions".

## 2026-10-06 — Session 2 (previous AI session; RECONSTRUCTED from the code and the owner's pasted terminal output)
- Added `drizzle/0001` (FK `project_baselines_cr_fk`) and `drizzle/0002` (`sessions`, `user_credentials`, RLS enabled).
- Added `src/db/apply-lockdown.ts` (`npm run db:lockdown`): RLS on all public tables, revoke anon/authenticated.
  Owner's run reported 57 public tables, 0 without RLS, 0 grants (see HANDOFF risk 1 about 57 vs expected 54).
- Added Hono auth API (`src/api/*`, `src/auth/*`, `src/server.ts`), `src/db/schema/auth.ts`, `src/db/test-guards.ts`.
- Owner output: `npm run typecheck` clean; `npm run test:auth` 12 passed, 0 failed.
- The previous session did NOT write docs: no `docs/` folder existed in the owner's repo.

## 2026-10-06 — Session 3 (Claude)
- Owner uploaded the real repo zip; Claude read it, diffed it against session 1, and rewrote the docs to match.
- Wrote (NOT yet run, Claude has no network): DB-backed rate limiting (`rate_limit_hits`, `src/auth/rate-limit.ts`,
  limits applied in `src/api/auth-routes.ts`), opt-in CORS in `src/api/app.ts`, `src/api/test-ratelimit.ts`,
  `test:auth`/`test:ratelimit` scripts, `CORS_ORIGINS` in `.env.example`.
- Next: owner runs Step 0 in NEXT_STEPS and pastes results; then Step 1 (core API).
- RESULT (owner ran Step 0 on Termux): `db:generate` -> `0003_curious_norrin_radd.sql`; `db:migrate` applied;
  `db:lockdown` 58 public tables, 0 without RLS, 0 grants; typecheck clean; test:auth 12/12; test:ratelimit 3/3;
  db:test-guards 19/19. Still open: 3 public tables not in our schema (58 vs 55).
- Next: Step 1 of NEXT_STEPS (idempotency + activity helpers, then requests/projects/tasks/quotes/milestones).
- FINDING: the 3 extra public tables are `admin_profiles`, `vehicle_images`, `vehicles` (another app). The database is shared.
  Side effect: `db:lockdown` also locked those tables. Owner must verify that app; plan is a dedicated Supabase project
  for this platform (NEXT_STEPS Step 0). Step 1 (core API) waits on that decision only for where migrations run.
- Owner listed policies: vehicles and vehicle_images have public-read and admin read/write/update/delete policies;
  admin_profiles has "admin reads own profile". Conclusion: only grants need restoring (RLS stays on). Restore SQL is in NEXT_STEPS Step 0.
- Owner ran the restore SQL on the shared project: `anon` and `authenticated` grants are back on vehicles, vehicle_images,
  admin_profiles (verified via information_schema). Owner still has to confirm the dealership site works.
- Rewrote `src/db/apply-lockdown.ts` to act only on this platform's tables (written in session 3, NOT yet run; output now
  prints our table count, tables missing from the DB, our tables without RLS, grants on ours, and the count of other
  tables left untouched). Do not run it against the shared project; run it on the new dedicated project.
- Owner ran everything against the SAME shared project (new project not created yet). Scoped `db:lockdown` output:
  55 of our tables defined, 0 missing, 0 without RLS, 0 grants, "other tables left untouched: 3" (the dealership tables).
  guards applied, seed ok, test:auth 12/12, test:ratelimit 3/3, db:test-guards 19/19.
- `npm run typecheck` flagged two TS errors in the new lockdown script (type predicate on `Object.values(schema)`); runtime was fine.
  Fixed by filtering with `is()` and casting (`as unknown[]` then `as PgTable`). Needs a re-run of typecheck.

## 2026-10-06 — Session 4 (Claude)
- Owner confirmed the shared-DB problem is fixed; grants query on `vehicles`, `vehicle_images`, `admin_profiles` showed full
  `anon`/`authenticated` privileges. (Owner still to eyeball the dealership site.)
- FINDING: the uploaded zip contained `.env` with live Supabase credentials (`.gitignore` does not protect `zip`).
  Owner told to rotate the DB password. Zip with `-x "labour-platform/.env"` from now on.
- Wrote Step 1 items 1-4 plus a read endpoint (NOT run: Claude has no network/node_modules; only a tsc syntax pass was done):
  `src/lib/idempotency.ts`, `src/lib/activity.ts`, `src/db/types.ts` (`Executor`), `src/authz/projects.ts`,
  `src/authz/organisations.ts`, `src/api/request-routes.ts` (POST /requests, GET /requests, GET /requests/:id,
  POST /requests/:id/convert), `src/api/project-routes.ts` (GET /projects/:id), `src/api/test-requests.ts`
  (`npm run test:requests`, 17 tests, self-cleaning).
- Changed: `src/api/http.ts` (added `ApiError`, `asApiError`, `parseOrThrow`, `uuidParam`, `isIanaTimezone`, `readJson`;
  existing exports untouched), `src/api/app.ts` (mounts /requests and /projects; `onError` maps `ApiError`; CORS exposes
  `Idempotent-Replayed`), `package.json` (script `test:requests`). No schema change, so no migration and no `db:lockdown` needed.
- Next: owner runs `npm run typecheck` and `npm run test:requests` and pastes output (see NEXT_STEPS).
- RESULT (owner, session 4 code): `npm run typecheck` clean; `npm run test:requests` 18 passed, 0 failed (so the `Executor`
  type and D20-D25 are verified live). `test:auth` / `test:ratelimit` / `db:test-guards` not re-run after the app.ts change yet.

## 2026-10-06 — Session 5 (Claude)
- Wrote Step 1 item 5 (NOT run): `src/engine/dependencies.ts` (pure cycle check), `src/api/task-routes.ts`
  (GET /tasks/:id, POST /tasks/:id/dependencies, POST /tasks/:id/transition), `POST /projects/:id/tasks` in
  `src/api/project-routes.ts`, `src/api/test-helpers.ts`, `src/api/test-tasks.ts` (`npm run test:tasks`, 9 tests).
- Changed: `src/api/app.ts` (mounts /tasks), `package.json` (script `test:tasks`). No schema change.

## 2026-10-06 — Session 6 (Claude)
- Owner asked Claude to continue and keep the README current. Claude extracted the zip (WITHOUT `.env`; the zip contained one again,
  so the DB password still needs rotating) and read the real code before writing anything.
- Wrote Step 1 item 6 (quotes) end to end. NOT RUN: Claude has no network/node_modules; a syntax-only `tsc` pass found no TS1xxx errors,
  but a real `npm run typecheck` has not happened.
- New schema: `task_invitations` in `src/db/schema/quotes.ts` (D28). NEEDS `npm run db:generate` (expect a migration `0004_*`), `db:migrate`, `db:lockdown`.
- New: `src/engine/quote-math.ts`, `QUOTE_TRANSITIONS` in `src/engine/state-machines.ts`, `src/api/provider-routes.ts`,
  `src/api/quote-routes.ts`, `src/api/test-quotes.ts` (`npm run test:quotes`, 17 tests), `registerProvider` helper.
- Changed: `src/api/app.ts` (mounts /providers, /quotes, and the task-scoped quote router on /tasks), `src/authz/projects.ts`
  (`isProviderOnly`, `providerVisibleTaskIds`), `src/api/project-routes.ts` and `src/api/task-routes.ts` (provider-only visibility, D31),
  `src/api/test-helpers.ts` (cleanup handles quotes, D34), `package.json` (`test:quotes`), README, these docs.
- Found while reading: `quotes.project_id`, `assignments.quote_id` and `provider_profiles.user_id` have no cascade, and quote freeze triggers
  also block DELETE, so any future "delete project/user" or erasure flow (PRD §130-131) must handle quotes explicitly.
- Next: owner runs the migration steps and `typecheck`, `test:tasks`, `test:quotes` (NEXT_STEPS Step 0b), pastes output, then Step 1 item 6b
  (provider accepts/rejects the assignment) and item 7 (milestones).
- RESULT (owner, session 6 code): migration `0004_lyrical_hedge_knight.sql` generated and applied; `db:lockdown` 56 tables, 0 without RLS, 0 grants;
  `typecheck` clean; `test:tasks` 10/10; `test:quotes` 13 passed, 4 failed. All 4 were TEST bugs, not API bugs: (1) the create-replay test
  rebuilt its body, and `validUntil` embeds a timestamp, so the hash differed (correctly 422); (2) the expiry test relied on a 6 s window that
  a slow network overran, which cascaded into the "rejected" and activity-count failures. Fixed: body built once; expiry is now forced with
  `expireQuoteVersion` (test-helpers, disables the freeze trigger for one UPDATE inside a transaction via DIRECT_URL). Needs a re-run.
- RESULT (owner, after the fix): `npm run test:quotes` 17 passed, 0 failed (includes the concurrent double-accept race, the frozen-version DB check,
  provider-only visibility and exact activity counts). An earlier run failed only because the phone could not resolve the Supabase host (DNS
  ENOTFOUND, flaky network): if every DB call fails with ENOTFOUND, fix the connection, do not touch the code.
  Not yet re-run after the session 6 changes: `test:auth`, `test:ratelimit`, `test:requests`, `db:test-guards`.

## Session 7
- Added `src/api/assignment-routes.ts`: `GET /assignments`, `POST /assignments/:id/accept`, `POST /assignments/:id/reject` (D35-D36).
- Added `src/api/test-assignments.ts` (`npm run test:assignments`) and `npm run test:all`.
- Wired the router in `src/api/app.ts`. README endpoint table updated. No schema change: no migration needed.
- NOT RUN: written without executing (no network/node_modules in Claude's sandbox). Run `npm run typecheck && npm run test:assignments`.

## Session 7 (continued)
- VERIFIED by the owner: typecheck clean; `test:assignments` 8/8 (after fixing the test to compare replay bodies by content, since jsonb reorders keys);
  `test:auth` 12, `test:ratelimit` 3, `test:requests` 18, `test:tasks` 10, `test:quotes` 17, `db:test-guards` 19.
- Added milestones + evidence metadata: `src/api/milestone-routes.ts`, `src/api/evidence-routes.ts`, `MILESTONE_TRANSITIONS` in
  `src/engine/state-machines.ts`, routers mounted in `src/api/app.ts`, `src/api/test-milestones.ts` (`npm run test:milestones`, added to `test:all`),
  cleanup in `src/api/test-helpers.ts` extended (D40). No schema change: no migration. (D37-D40)
- NOT RUN: written without executing. Run `npm run test:all`.

## Session 7 (continued, 2)
- VERIFIED by the owner (`npm run test:all`): typecheck clean; auth 12, ratelimit 3, requests 18, tasks 10, quotes 17, assignments 8, milestones 10,
  db:test-guards 19. `test-ratelimit.ts` was flaky across a 60 s window boundary: it now waits out the last 10 s of a window first.
- Added the task work lifecycle (D41-D44): `src/api/task-work-routes.ts`, `src/api/test-task-work.ts` (`npm run test:task-work`, in `test:all`). No schema change.
- NOT RUN: written without executing. Run `npm run test:all`.


## Session 8
- Wrote Step 3a (NOT RUN until the owner reports): src/payments/*, src/engine/fees.ts, src/api/payment-routes.ts, src/api/test-payments.ts (`npm run test:payments`, in test:all). No schema change.
- Endpoints: POST /milestones/:id/payments, POST /milestones/:id/release, GET /payments/:id, POST /payments/:id/verify, POST /webhooks/:provider.

## Session 9 (Claude)
- Owner added Paystack (session 8 code) and reported `npm run test:payments` 12 passed, 0 failed, plus one cleanup WARN. Owner uploaded the full repo; Claude read it.
- Discarded an unfinished parallel draft of requests/projects/tasks endpoints that Claude had started before seeing the repo (the repo already had them; never delivered).
- Reviewed src/payments/*, src/api/payment-routes.ts, src/engine/fees.ts. Findings are in HANDOFF "PAYMENTS: WHAT IS AND IS NOT DONE" and NEXT_STEPS Step 3b.
- Fixed the cleanup WARN: webhook-written `activity_events` have a NULL actor, so `cleanupTestUsers` now also deletes activity by project (src/api/test-helpers.ts).
- Added `src/payments/test-paystack.ts` (`npm run test:paystack`, in `test:all`): 12 tests of the real Paystack adapter against a local fake server. NOT RUN yet.
- `.env.example` now documents PAYMENTS_PROVIDER, PAYSTACK_SECRET_KEY, PAYMENTS_CALLBACK_URL, PAYSTACK_BASE_URL.
- NOT RUN: written without executing. Run `npm run typecheck && npm run test:paystack && npm run test:payments`.
- VERIFIED by the owner (session 9): typecheck clean; `test:paystack` 12/12; `test:payments` 12/12 with NO cleanup warning (the activity-by-project fix works).
  Paystack adapter is now proven against a fake gateway only; the live test-mode checklist (NEXT_STEPS Step 3b) is still the owner's to run.
- Next chosen: Step 2 (Vercel entry), because the Paystack webhook needs a public HTTPS URL.
- Step 2 written (NOT RUN, NOT DEPLOYED): `src/index.ts` (Vercel entry), `src/node-server.ts` (renamed from src/server.ts), `vercel.json` (region dub1),
  `src/api/test-entry.ts` (`npm run test:entry`, in `test:all`), `docs/DEPLOY.md`. D50-D52. Run: `rm src/server.ts && npm run typecheck && npm run test:entry`.
- Clarified with the owner: deployment is optional; everything runs on localhost. Added `src/dev/live-paystack.ts` (`npm run live:paystack`): an interactive localhost live test
  against Paystack TEST mode (refuses non-test keys; no webhook needed). NOT RUN.
- VERIFIED by the owner (session 9): `src/server.ts` removed; typecheck clean; `test:entry` 5/5 (health, JSON 404, auth 401, webhook error handling all survive the Vercel wrapper).
  Still NOT done: an actual Vercel deployment, and the localhost live Paystack test (`npm run live:paystack`).

## 2026-10-07 — Session 10 (Claude): everything planned before the Vercel deploy
- VERIFIED by the owner: `npm run live:paystack` PASSED against Paystack TEST mode (real checkout, verify -> secured, approve, release; earnings 500000 kobo,
  fee 0). First real-gateway proof of the collection side.
- SECURITY FINDING (3rd time): `.env` (database URLs, `PAYSTACK_SECRET_KEY` test key, and a `PAYSTACK_PUBLIC_KEY` starting `pk_l`, i.e. a LIVE-mode public key)
  was inside the zip shared in chat. Rotate the DB password and the Paystack test secret key; delete the unused PAYSTACK_PUBLIC_KEY line. Zip with
  `-x "labour-platform/.env"` always. (Claude never printed the values.)
- Written, NOT RUN (no network/node_modules in the assistant sandbox; only a tsc syntax pass): abandoned checkout + late-success suspense (D53), gateway refund/dispute
  logging (D54), payouts end to end (D55-D57), admin attention queue and payout queue (D56), reconciliation (D58).
  New: `src/payments/{payouts,gateway-events,reconcile}.ts`, `src/authz/platform-admin.ts`, `src/api/{payout-routes,admin-routes}.ts`,
  `src/dev/{live-payout,reconcile-paystack}.ts`, tests `src/api/test-{checkout,payouts}.ts`, `docs/LAUNCH_CHECKLIST.md`.
  Changed: `provider.ts` (optional `payouts`, `listTransactions`; reference parsing), `ledger.ts` (projectId optional, payoutId), `sandbox.ts`, `paystack.ts`,
  `service.ts`, `payment-routes.ts` (stale checkout, webhook branches), `app.ts`, `schema/finance.ts` (NEW table `provider_payout_accounts`; new columns on `payouts`:
  failure_reason, approved_by_user_id, approved_at; unique (provider_code, provider_reference), index), `test-helpers.ts` (cleanup), `package.json`, `.env.example`, docs.
- SCHEMA CHANGE: needs `npm run db:generate && npm run db:migrate && npm run db:lockdown` (db:guards unchanged).
- NOT done and cannot be done by Claude: rotate secrets, run tests, deploy, set the Paystack webhook, legal review, KYC, real-money decision.

## 2026-10-08 — Session 10 follow-up (owner's first run of the pre-deploy code)
- RESULTS: typecheck clean; migration `0005_parallel_forgotten_one` applied; `db:lockdown` clean (57 tables, 0 without RLS); `test:checkout` 10/10; `test:auth`, `test:ratelimit`,
  `test:requests`, `test:tasks`, `test:quotes`, `test:milestones` all green.
- `test:payouts` setup FAILED and cascaded (13 failures): the test seed posted a two-line ledger entry OUTSIDE a transaction, so the first line committed alone and the deferred
  "entry must balance" trigger (guards.sql 4b) rejected it. FIX: seed wrapped in `db.transaction` in `test-payouts.ts` and `live-payout.ts`. Lesson: `postEntry` must ALWAYS run inside a transaction.
- `test:assignments` (late), `test:task-work` failed with ECONNABORTED / CONNECTION_CLOSED / ENOTFOUND aws-1-eu-west-1.pooler.supabase.com: the PHONE'S NETWORK dropped mid-run (not code). Re-run on stable Wi-Fi with `termux-wake-lock`.

## 2026-10-08 — Session 10, results and deploy tooling
- OWNER RESULT: after the seed fix, `test:payouts` 18/18 and the FULL `npm run test:all` is GREEN (14 suites, 0 failures), including checkout 10/10, payouts 18/18, payments 12/12, guards 19/19.
- Still unverified against the real gateway: payout methods in `paystack.ts` and `listTransactions` (run `npm run live:payout`, `npm run reconcile`).
- Added `npm run deploy:check` (pre-deploy: .env tracked?, test key?, required files, prints names only) and `npm run smoke -- <url>` (post-deploy: health, 404 shape, register, auth, idempotency rule,
  unsigned webhook 401, admin hidden, Paystack reachable via the bank list).

## 2026-10-09 — Session 10, first real-gateway payout attempt
- `npm run deploy:check` clean (only the `PAYSTACK_PUBLIC_KEY` warning remains: delete that line from `.env`).
- `npm run live:payout`: steps 1-2 WORKED against real Paystack (287 banks listed: key, outbound call and bank-list mapping verified). Step 3 failed because the account tried (Access Bank 044,
  number 0123456789) is invented, and Paystack TEST mode rejects such accounts ("Sorry, We can't make the transfer to this recipient at the moment"). Paystack's documented TEST transfer account is
  Zenith Bank code 057, account 0000000000 (paystack.com/docs/payments/test-payments). The script now defaults to it, and gateway errors say which step failed.
- `npm run reconcile` WORKED against the real API (`listTransactions` verified: 3 transactions read). It reported 3 `unknown_at_our_side` payments of 500000 NGN: these are the owner's earlier
  `live:paystack` runs, whose database rows the script deleted afterwards while Paystack keeps the transactions. Expected noise, not a fault; in production an unknown reference is a real alert.
- From Paystack's Single Transfers docs: test transfers ALWAYS return success immediately (no processing); retries must reuse the same reference (we do); reference rules lowercase/digits/_/- 16-50 chars (ours: `lpo_`+32 hex);
  the OTP switch is Dashboard > Settings > Preferences > 'Confirm transfers before sending'; webhook events `transfer.success|failed|reversed` carry `data.reference` (we read it).

## 2026-10-09 — Session 11 (Claude): from "search electrician" to a quote
- Found: Find searched only names/headlines, providers had no trades, and the project page said the invite screen was "the next screen we are building".
- Added trades (D59), invite screen, manager invitations list + quote accept screen, per-provider message thread (D60-D61), provider quote form, Find -> invite shortcut (D62-D63). No schema change, so no `db:generate`/`db:lockdown`.
- Verified by the owner: `npm run typecheck` clean, web `tsc --noEmit` clean, `npm run test:threads` 5/5 (services, directory by category, invitations list + threads, access control, replay).
- NOT verified: the screens were never exercised by an automated UI test; walk the flow by hand (two accounts) and record the result here.
- Process miss: this session delivered a zip instead of terminal commands and did not update the docs until the owner asked whether everything matched them.
- Session 11, second half (aligning with the PRD): change requests (D64-D68), reviews (D69-D70), in-app notifications (D72), removal of the hard-coded NG market, Lagos timezone fallback and NGN bank default (D71, D73),
  `docs/PRD.pdf` added, `docs/PRD_COVERAGE.md` added, SCHEMA.md / README / `.env.example` brought up to date. No schema change, so no migration.
- Verified so far: typecheck clean for API and web, `vite build` OK. NOT YET RUN by the owner: `npm run test:changes` (new, covers changes, reviews, notifications); the new screens have not been walked by hand.
- Verified (owner's terminal output, session 11): typecheck clean; `test:changes` 9/9; `test:threads` 5/5.
- Fixed: test cleanup (`cleanupTestUsers`) did not delete `reviews`, so its transaction rolled back and left test users behind. It now deletes reviews first; the next `test:changes` run also removes the leftovers of the failed one.
- Fixed (second cleanup bug): `project_baselines` is append-only, so deleting a test project that had change requests was refused. `cleanupTestUsers` now disables that trigger inside its transaction, deletes the baselines, and re-enables it.

## 2026-10-10 — Session 12 (Claude): the work itself (start, evidence, submit, approve) and the timeline
- Added: evidence upload-url + verified confirm + signed download links (D74-D75), project timeline endpoint (D76), task work screen and Timeline panel (D77). New test `npm run test:work`.
- No schema change, so no migration. The task-work API was not changed.
- NOT YET RUN by the owner: `npm run test:work`; the new screens have not been walked by hand; real photo upload needs the Supabase bucket from D40 (never live-tested with this code).
- Honest limits: an upload that stops half way must be retried from the start (no resume, PRD §110); no offline capture (PRD §111); videos up to 100 MB depend on the phone's connection.
- Verified (owner's terminal output, session 12): typecheck clean (API + web); `test:work` 5/5, `test:changes` 9/9, `test:threads` 5/5. Screens and live Supabase upload still to be tried by hand.

## 2026-10-10 - Session 13 (Claude): PRD alignment audit
- Landing copy aligned with D46/PRD §49 (no escrow-style claims), removed an unbuilt "fees shown up front" claim, marked Phase 6/7 audience points as planned.
- Open finding: web has no screens for milestones, funding, approval, release or earnings (API only). Next build.
- Open finding: web keeps its own category list (PRD §24); provider lists are alphabetical (PRD §96); neither is "ranked", and the UI correctly does not say so.

## 2026-10-10 - Session 13 (Claude), part 2: the money loop on screen
- Added `GET /projects/:id/awards` and `GET /projects/:id/payments` (money roles only; provider-only 404; no gateway reference) + `npm run test:money-views`.
- Added web `MilestonesPanel` (stages, fund via Paystack checkout, submit, approve, ask for changes, release) and `/pay/return` (verifies, polls a few times).
- Needs `PAYMENTS_CALLBACK_URL=<web origin>/pay/return` in `.env` (set to the local dev value by this session).
- NOT YET RUN by the owner: test:money-views, the new screens. No schema change.
- FINDING (backend, not fixed): `pending -> submitted/in_progress` is still legal in MILESTONE_TRANSITIONS (a pre-payments leftover). An unfunded milestone can be submitted and approved,
  and then can never be funded (payment creation requires `pending`). PRD §48 order is fund, then work. The UI only offers Submit when funded; the API still allows it.

## 2026-10-11 - Session 13 (Claude), part 3: fund before work (D78)
- milestone submit refuses an unfunded stage with money in it (`milestone_not_funded`); tests in test-milestones, test-task-work, test-payments updated (+ test-fund.ts helper, + new payments test).
- NOT YET RUN by the owner.
- Added web Earnings screen (/earnings, linked from Profile for providers): balances by currency (available / in transit / paid out), payout account with bank picker, payout request, history. Not yet walked by hand.
- Payouts need a platform admin to approve them (API exists, no admin screen yet) and, on real Paystack, an upgraded (non-Starter) account.

## 2026-10-11 - Session 13 (Claude), part 4: admin payout screen
- /admin/payouts now returns providerName + destination (accountName, bankCode, accountLast4); never the full number or recipient code. + `npm run test:admin-view`.
- Web: /admin page (attention counts, payout queue by state, two-step approve, reject with reason, check status) and an Admin link in the avatar menu for staff (probes /admin/attention).
- NOT YET RUN by the owner.
- Fixed: test cleanup now also removes the ledger seed of `test:admin-view` (key `adminview:<providerId>:seed`); before, its cleanup rolled back on a foreign key and left test users behind.

## 2026-10-12 - Session 14 (Claude): clearer project page
- Reviewed the uploaded zip. Found the blueprint layer (docs/BLUEPRINT.md) in the code with no CHANGELOG entry; noted in PRD_COVERAGE. Owner reports all tests pass; test:blueprint is part of test:all.
- Web: JourneyBar (7-step bar + next-step card), tabbed ProjectPage, plain-language task/stage labels (`Pill` takes an optional `label`). No API change.
- NOT YET RUN by the owner: web typecheck and the new screen.
- Web (session 14): Home first-run guide (HowItWorks), provider lane (WorkLane), Everything-else page grouped by intent (More.tsx), plainer request heading. NOT YET RUN by the owner.
