# Labour Platform — Phase 1 / 1A foundation

Postgres schema (Drizzle ORM), database guards, deterministic state machines and a Hono HTTP API for the
PRD's universal project engine (request -> project -> tasks -> invitations -> quotes -> award; milestones,
evidence and payments are next).

**Handing over or resuming? Read `docs/HANDOFF.md` first, then `docs/NEXT_STEPS.md`.**
Anything marked "written, not run" in the docs has never been executed: the AI sessions have no network or
`node_modules`, so only the owner's terminal output proves a thing works.

## Setup
```bash
npm install
cp .env.example .env      # fill DATABASE_URL (pooled) and DIRECT_URL (direct/session)
npm run typecheck
npm run db:generate       # only after schema edits; writes SQL migrations to ./drizzle (commit them)
npm run db:migrate
npm run db:guards         # triggers: append-only, immutable quotes/messages, ledger balance
npm run db:lockdown       # RLS on, anon/authenticated grants revoked, OUR tables only
npm run db:seed           # languages, currencies, Nigeria market, sample taxonomy
npm run dev               # API on http://localhost:8787
```
Run `db:guards` again after any migration that drops/recreates the guarded tables, and `db:lockdown` after any
migration that creates tables.

## Tests (need a seeded dev database; all self-clean via DIRECT_URL)
```bash
npm run db:test-guards    # 19 database-level integrity tests
npm run test:auth         # 12
npm run test:ratelimit    # 3
npm run test:requests     # 18
npm run test:tasks        # tasks, dependencies, transitions
npm run test:quotes       # invitations, quotes, versions, accept
npm run test:assignments  # provider accept / reject of an award
npm run test:milestones   # milestones and evidence metadata
npm run test:task-work    # start / submit / approve / complete
npm run test:all          # typecheck + every suite
```
Last verified counts are in `docs/HANDOFF.md` ("Current status"); do not trust this list over that file.

## Layout
- `src/db/schema/` — one file per domain (config, taxonomy, identity, projects, quotes, delivery, chat, finance, audit, auth)
- `sql/guards.sql` — integrity rules Drizzle cannot express (idempotent, re-runnable)
- `src/engine/` — pure logic, no I/O: `state-machines.ts` (task §134, payment §135, quote), `dependencies.ts` (cycle check), `quote-math.ts` (BigInt money maths)
- `src/authz/` — object-level access checks (project roles, organisation roles, provider-only visibility)
- `src/lib/` — `idempotency.ts` (every write), `activity.ts` (activity stream)
- `src/api/` — Hono routers (`*-routes.ts`) and integration tests (`test-*.ts`); `app.ts` mounts everything
- `src/db/client.ts` — runtime client (pooled, `prepare: false`)

## API surface (all JSON; `Authorization: Bearer <token>`; every POST/PUT also needs an `Idempotency-Key` header)
| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /me`, `GET /health` |
| Requests | `POST /requests`, `GET /requests`, `GET /requests/:id`, `POST /requests/:id/convert` |
| Projects | `GET /projects/:id`, `POST /projects/:id/tasks` |
| Tasks | `GET /tasks/:id`, `POST /tasks/:id/dependencies`, `POST /tasks/:id/transition` |
| Providers | `POST /providers/me`, `GET /providers/me`, `GET /providers/me/invitations`, `GET|PUT /providers/me/services`, `GET /providers[?q=&category=]` (directory) |
| Invitations + quotes (manager) | `POST /tasks/:id/invitations`, `GET /tasks/:id/invitations`, `GET /tasks/:id/quotes`, `POST /quotes/:id/request-revision`, `/reject`, `/accept` |
| Milestones | `POST /projects/:id/milestones`, `GET /projects/:id/milestones`, `GET /milestones/:id`, `POST /milestones/:id/submit` (provider), `/approve`, `/request-changes` (approver) |
| Evidence (metadata) | `POST|GET /tasks/:id/evidence`, `POST|GET /milestones/:id/evidence` |
| Task work | `POST /tasks/:id/start`, `/submit` (provider); `/request-changes`, `/approve`, `/complete` (manager) |
| Changes (PRD §58-60) | `POST|GET /projects/:id/changes`, `POST /changes/:id/accept`, `POST /changes/:id/reject`, `POST /changes/:id/withdraw` |
| Reviews (PRD §91) | `GET|POST /projects/:id/reviews`, `GET /providers/:id/reviews` |
| Notifications (PRD §112) | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` |
| Evidence files (PRD §66) | `POST /tasks/:id/evidence/upload-url`, `POST|GET /tasks/:id/evidence` |
| Timeline (PRD §68) | `GET /projects/:id/activity[?limit=&before=]` |
| Messages (manager <-> one invited provider) | `GET|POST /tasks/:id/messages[?provider=<profileId>]` |
| Assignments (provider) | `GET /assignments[?status=]`, `POST /assignments/:id/accept`, `/reject` |
| Quotes (provider) | `POST /tasks/:id/quotes`, `PUT /quotes/:id` (draft only), `POST /quotes/:id/submit`, `/revise`, `/withdraw`; `GET /quotes/:id[?version=n]` (both sides) |

Happy path: task `draft` -> `ready` (manager) -> invite provider(s) (task becomes `offered`) -> provider drafts and
submits a quote -> manager accepts it (task `assigned`, assignment `offered`, provider joins the project).
The provider then accepts or rejects the assignment (`/assignments/:id/accept|reject`). Milestones and evidence metadata follow; payments are next.

## Conventions
- Money = integer minor units + explicit `currency` column. No floats, no inferred currency. Servers compute every amount.
- Service identity = `canonical_key`; names live in translation tables.
- Ledger balances are derived from `ledger_lines`; each entry must balance per currency.
- Evidence, activity events, ledger rows and baselines are append-only (DB-enforced); submitted quote versions and their lines are frozen (DB-enforced).
- Because of that, deleting a project that has evidence/ledger/quote rows is blocked by design (test cleanup disables the triggers inside one transaction); retention/erasure rules (PRD §130-131) need an explicit process later.
- Every consequential write goes through `runIdempotent` and emits an `activity_events` row in the same transaction.
- Errors: `{ "error": { "code", "message", "details?" } }`. 404 = no relationship to the object; 403 = member with too little role.
- Authorization lives in the Node API, never in Supabase RLS policies.

## Mapping notes (PRD §127 table names)
`market_measurement_preferences` -> `markets.measurement_system`;
`market_calendar_rules` -> `markets.working_days/business_hours` + `market_holidays`.

## Keeping the docs alive
Every session: append to `docs/CHANGELOG.md`, add decisions to `docs/DECISIONS.md`, move finished items out of
`docs/NEXT_STEPS.md`, and update "Current status" in `docs/HANDOFF.md`. Update this README when an endpoint,
script or convention changes. Never zip `.env`.

## Request intake (guided questions + photo/video)
See `docs/INTAKE.md`: endpoints, decisions, run order, storage setup. Test: `npm run test:intake`.
