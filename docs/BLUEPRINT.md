# Blueprint layer

This layer adds every PRD domain that was not yet built, as real tables, validated routes and screens. Anything that
needs a vendor (AI, translation, speech, identity, tax, payments for orders) sits behind an adapter that is **off by
default**, so nothing here blocks the platform and nothing is wired to a vendor you have not chosen (PRD §20, §149).

Nothing in this layer has been run against your database yet. The first job is the apply-and-verify list at the bottom.

## Apply

```bash
npm run db:generate          # creates the migration for src/db/schema/blueprint.ts (52 new tables)
npm run db:migrate
npm run db:lockdown          # the new tables get RLS like the rest
npm run db:seed              # existing seed (languages, currencies, market, first categories)
npm run db:seed:blueprint    # 16 categories + translations + synonyms, 4 approved templates, flags, policies
npm run typecheck && npm run test:blueprint
```

## Plug-in points (all in `src/ai/providers.ts`)

| Seam | Env | Default | To plug a real vendor |
|---|---|---|---|
| AI | `AI_PROVIDER` | `none` | implement `AiProvider`, add one `case` in `getAi()` |
| Translation | `TRANSLATION_PROVIDER` | `none` | `ai` routes through the governed AI path; or implement `TranslationProvider` |
| Speech | `SPEECH_PROVIDER` | `none` | implement `SpeechProvider.transcribe` |
| Identity checks | `manualIdentityVerifier` | pending until a platform admin decides | implement `IdentityVerifier` per country (`market_verification_rules.adapter_code`) |
| Tax | `market_tax_rules` | rules read from the database | add rows per market; orders and procurement read them |
| Payments for merchant orders | `merchant_orders.payment_state` | stays `created` | collect through the existing payment orchestration layer |
| Notification channels | `notification_preferences` | in-app | add a sender per channel in `lib/notify.ts` |

Every AI call goes through `ai/govern.ts`: feature flag (`ai.enabled`, `ai.<purpose>`), per-person daily allowance, a log row
in `ai_interactions`, optional cost tracking. Callers catch `AiUnavailable` and continue deterministically, so the project
never depends on a model.

## PRD map

| PRD | What | Where |
|---|---|---|
| §3-4, 37, 80 | understand a need, path A/B/C, emergencies | `ai/rules.ts`, `POST /discover/classify` |
| §24 | taxonomy in the database, translated, synonyms | `GET /categories`, `seed-blueprint.ts` |
| §16-21 | questions, drafts, retrieve → adapt → generate, accept | `ai/draft.ts`, `ai-routes.ts` (`/ai/questions`, `/requests/:id/drafts`, `/drafts/:id/accept`) |
| §22-23 | template library, versions, approval, superseding | `catalog-routes.ts` (`/templates`) |
| §28-35 | contextual chat, translation provenance, confirm understanding, voice, read state | `conversation-routes.ts`, `i18n/translate.ts` |
| §33, 54, 59, 104, 144 | assistant from the record, quote compare, change impact, dispute summary, project brief | `ai/context.ts` |
| §38, 94-97 | explainable provider ranking, fair to newcomers, labelled promotion | `GET /discover/providers` |
| §41-43, 71-75 | availability, bookings, travel buffer, holidays, cancellation policy, no-show, check-in | `schedule-routes.ts` |
| §65, 78-79 | updates, blockers, issues, safety incidents | `ops-routes.ts` |
| §77 | health computed from data | `POST /projects/:id/recompute-health` |
| §101-104 | disputes scoped to one obligation | `dispute-routes.ts` |
| §81, 88-93 | verification, insurance, explainable trust, subcontracting, teams | `trust-routes.ts` |
| §98 | moderation reports and automatic flags | `lib/moderation.ts`, `/moderation` |
| §7-8, 76, 114-118 | organisations, sites, budgets, approval chains, preferred providers, SLA, recurring | `org-routes.ts`, `schedule-routes.ts` |
| §13, 51, 63-64, 82-86, 123 | merchants, products, orders, procurement, assets, warranties, claims, hire again | `commerce-routes.ts` |
| §138-140 | documents, handover checklist, closure record | `ops-routes.ts` |
| §119-122, 161 | programmes, registries, outcomes, insights (small groups hidden) | `platform-routes.ts` |
| §127-131 | market configuration, retention, privacy export and deletion requests | `platform-routes.ts`, `trust-routes.ts` |
| §145, 150-151 | admin overview, events, AI usage, flags | `platform-routes.ts` |
| §72, 89, 118 | scheduled jobs | `/jobs/*` with `x-cron-secret` |

## Decisions worth knowing

- New tables use TEXT status columns validated by zod, so a market or programme can add a state without a migration.
- No new append-only triggers: they would block cascade deletes. Immutability is enforced by having no update route
  (dispute entries, translations, activity).
- Disputes freeze only the disputed milestone. Releasing a dispute restores the prior state; `refund` cancels the milestone
  and `release` approves it. The money itself still moves through the existing payment routes.
- Approvals are an explicit workflow. `requiresApproval()` in `org-routes.ts` is the single gate; procurement uses it today.
  To gate quote acceptance or milestone funding, call it from those routes.
- `message_translations` is append-only, so test cleanup disables its trigger (see `test-blueprint.ts`).

## Not done, on purpose

- No vendor is connected. AI, translation and speech are adapters only.
- Subcontractor task visibility: approval records the decision and adds a `provider_team_member`; giving them task access
  needs an assignment, which touches payments, so it is left for you to decide.
- Merchant order payment collection, tax filing, real identity providers, SMS/email/push senders.
- Quote acceptance and milestone funding are not yet gated by approval policies.

## Apply-and-verify checklist

1. `db:generate` output: read the SQL once. 52 `CREATE TABLE` and no `DROP`.
2. `npm run typecheck`: the one place real type errors can still hide (this layer was written without a build).
3. `npm run test:blueprint`: 12 tests. Read the first failure; later ones may cascade from it.
4. Turn AI on last: `AI_PROVIDER=mock` first, then a real provider with `AI_DAILY_LIMIT=5`.
