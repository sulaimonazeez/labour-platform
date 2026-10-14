# SCHEMA map (59 tables defined by this platform as of session 11; session 11 changed no schema). Source: `src/db/schema/*.ts`. Enums: `enums.ts`.

| File | Tables | PRD refs |
|---|---|---|
| config.ts | languages, currencies, markets, market_languages, market_currencies, market_payment_methods, market_tax_rules, market_verification_rules, market_service_rules, market_holidays, market_compliance_settings | §2, §43-46, §124-128 |
| taxonomy.ts | service_categories, service_category_translations, service_category_synonyms | §24, §37 |
| identity.ts | users, organisations, organisation_members, provider_profiles, provider_services, verifications | §26, §87-89, §114 |
| projects.ts | requests, request_candidates, projects, project_members, stages, tasks, task_dependencies, project_budgets | §14, §56, §70, §95 |
| quotes.ts | quotes, quote_versions, quote_line_items, assignments, task_invitations | §52-53, §65, §95 |
| delivery.ts | project_baselines, change_requests, change_request_tasks, milestones, evidence, reviews | §57-60, §66-67, §91 |
| chat.ts | conversations, conversation_participants, messages, message_translations | §28-34 |
| finance.ts | provider_payout_accounts, payments, payouts, platform_fee_rules, ledger_accounts, ledger_entries, ledger_lines, fx_conversions | §46-51, §135 |
| intake.ts | request_answers, request_attachments | INTAKE.md |
| auth.ts | user_credentials, sessions | D14 |
| ratelimit.ts | rate_limit_hits | D17 |
| audit.ts | activity_events, idempotency_keys, notifications | §112-113, §133, §136-137 |

Note: `db:lockdown` counted 58 public tables when we had 55 (3 belong to another app: see HANDOFF risk 1). Today `db:lockdown` should report "59 of our tables defined, 0 without RLS".

Not yet modelled (PRD phases later): templates, issues, safety incidents, disputes, assets,
warranties, teams, subcontracting, merchants/orders, SLAs, feature flags, user credentials/sessions.
(`user_credentials` and `sessions` now exist in auth.ts.)

Key relationships: users -> provider_profiles (1:1). requests -> projects (optional). projects ->
stages -> tasks -> assignments -> quotes. milestones belong to projects (optionally an assignment).
payments belong to projects (optionally a milestone). ledger_entries link to payment/payout/milestone.
