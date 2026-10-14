# PRD coverage (v2.0, Aug 2026): what is built, what is partial, what is not
> NOTE (session 14): the "Blueprint layer" (docs/BLUEPRINT.md: 52 tables, about 40 more routes and 15 more screens for schedule, disputes, assets,
> trust, organisations, shop, programmes, templates, and AI / translation / speech adapters that are OFF by default) is in the code, but this table was NOT
> re-audited after it landed and its CHANGELOG entry is missing. Treat the "Not started" list below as out of date until the next audit.

Source of truth for scope: `docs/PRD.pdf` (85 pages, 172 sections). Last audited: session 11 (2026-10-09).
How it was checked: table, route and file lists compared against the PRD and these docs, plus the session 11 tests.
Statuses: BUILT = API plus a screen where a person needs one; API = server only; PARTIAL = see note; NO = not started.
Keep this file current: when a PRD item changes status, change its row and add a CHANGELOG line.

## PRD §152 Phase 1 list
| PRD item | Status | Note |
|---|---|---|
| users, auth | BUILT | D14, D17. Email + password only. |
| providers, provider profiles | BUILT | Trades are picked by canonical key (D59). Verification classes (§88) are NO. |
| service taxonomy | PARTIAL | Tables + translations exist; only 3 categories are seeded; the web mirrors the list in `web/src/lib/taxonomy.ts` instead of reading an endpoint. |
| requests (+ intake photos/voice/answers) | BUILT | INTAKE.md. Voice transcription, photo GPS stripping (INTAKE-6) are open. |
| projects, stages, tasks, dependencies | BUILT | |
| assignments | BUILT | Provider accept/reject; one live assignment per task. |
| scheduling (§71) | NO | `tasks.planned_*` columns exist; no API or screen. Change requests record `scheduleDeltaDays` only. |
| quotations (§52-53) | BUILT | Versioned. Provider form: labour, materials, transport lines. Revision screens are NO (API exists). |
| contextual chat (§31-34) | PARTIAL | Only the pre-award thread per (task, provider) (D60-D61). No project, stage, task, milestone, change or dispute chat. No translation (§28-30 are Phase 2). |
| project updates | NO | |
| evidence (§66-67) | BUILT | Upload-url + verified confirm + signed links (D74-D75); task work screen. Milestone evidence has no screen. |
| milestones (§57) | PARTIAL | Project-page panel (session 13): add stage, fund, submit, approve, ask for changes, release. Screens not yet walked by hand. Milestone evidence still has no screen. |
| budget (§56) | PARTIAL | Estimated and approved are stored; approved moves with accepted changes (D67). Committed, funded, paid, pending, forecast are not exposed. |
| change requests (§58-60) | BUILT | Session 11, D64-D68. Does not adjust milestones or payments; no change chat. |
| payment architecture, platform fee (§47-51) | PARTIAL | Paystack + sandbox, ledger, payouts (D49-D57). Paystack is Nigeria-only (D57). |
| activity timeline (§68, §137) | BUILT | `GET /projects/:id/activity` + Timeline panel (D76). Role-filtered; some event wording is still generic. |
| provider workspace (§65) | PARTIAL | Accept job, start, evidence, submit, see status (D77). No check-in/arrival (§73), blockers, material requests, milestone submission screen, or offline mode (§111). |
| notifications (§112-113) | PARTIAL | In-app inbox + bell (D72). No push/email/SMS, no quiet hours or channel preferences. |
| reviews (§91-92) | BUILT | Session 11, D69-D70. Customer reputation (§93) is NO. |
| basic market/country configuration (§127) | PARTIAL | Tables seeded (NG); `GET /reference` is the only way to read them. Sign-up now takes the market from it (D73). |

## Rules the PRD sets that the code must keep
| PRD rule | Status |
|---|---|
| §2 nothing hard-coded to one country | PARTIAL. Fixed in session 11: web default market, timezone fallback, payout bank currency (D71, D73). Still Nigeria-specific: Paystack payouts (D57), seed data, `NGN` in test helpers. |
| §20, §171 AI is never the system of record | OK: no AI is wired in. |
| §28 original messages never overwritten | OK (database guard on `messages`). |
| §34 providers do not see every conversation | OK for the pre-award thread. |
| §45 every money record has an explicit currency | OK. |
| §59 never silently modify the agreement | OK for tasks/budget via change requests; milestones and quotes follow their own flows. |
| §99 contact details released by stage | OK: phone numbers are never returned. |
| §132 object-level access | OK: 404 for non-members, 403 for members without the role. |
| §133, §137 audit + activity stream | OK: written everywhere and readable through the timeline (D76). |
| §136 idempotency on consequential writes | OK: every write route uses `runIdempotent`. |

## Not started (PRD phases 2 and later; the docs already list these as later)
Translation and voice (§28-35, Phase 2), AI assistant (§16-23, §105-108, Phase 3), provider matching and ranking (§38, §96, Phase 4),
teams, recurring services, advanced verification, SLAs, assets, warranties, procurement, merchants, organisations and approval chains,
government programmes, labour-market analytics, disputes (§102-104), safety incidents (§79), insurance (§81), data residency and retention (§129-131).
