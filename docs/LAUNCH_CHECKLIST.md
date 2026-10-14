# LAUNCH CHECKLIST: things only a human can do (written session 10)

The code can be finished; these cannot. This is a checklist of questions and tasks, NOT legal or financial advice: get a qualified lawyer and, where needed, a licensed
payments adviser in each country before taking real money.

## A. Before ANY real money (blockers)
- [ ] **Regulatory position of "protected payment" (D46).** The platform holds customer money between payment and release. In many countries that can be a regulated activity
      (escrow, e-money, payment-service, or marketplace-payments licensing). Ask counsel: Do we need a licence, or can the gateway's marketplace/split features carry it?
      Is the ledger's `protected_funds` account allowed to be described as "escrow"? What wording is permitted in the UI and the terms?
- [ ] **Gateway account in live mode.** Complete the gateway's business verification; confirm in writing that (a) collecting for third-party providers and (b) paying out
      to them via Transfers are permitted for this business model; confirm transfer fees, limits and settlement timing.
- [ ] **Terms of service, privacy policy, refund/cancellation policy, dispute process** drafted by counsel, versioned, and accepted in-app before payment.
- [ ] **Data protection:** register/comply with the local regime (for Nigeria, the NDPA/NDPC rules), define retention (PRD §130), a deletion/export process, and a breach procedure.
- [ ] **Tax:** VAT/withholding on the platform fee and on provider earnings; invoices/receipts; who is the seller of record. The code records fees but computes no tax yet (PRD §124).
- [ ] **Provider identity (KYC) and payout compliance (PRD §125):** not built. Decide the standard (ID check, BVN/NIN where lawful, sanctions screening) and build it; until then every payout
      relies on a human admin approving it.

## B. Secrets and access
- [ ] Rotate every secret that has ever been shared in a chat or zip (DB password, Paystack key). Use a fresh live key only on the server (Vercel env), never in `.env` on a phone.
- [ ] Remove `PAYSTACK_PUBLIC_KEY` from `.env` (unused). Never mix `pk_live_` with `sk_test_`.
- [ ] Supabase: separate project for this platform (the shared one also runs the dealership), RLS lockdown re-run after every migration, backups on, point-in-time recovery if the plan allows.
- [ ] `PLATFORM_ADMIN_USER_IDS`: only real staff. Replace with a proper admin model (roles, MFA, audit UI) before more than one or two staff exist.
- [ ] `npm audit` reviewed; dependency update policy.

## C. Operations
- [ ] Deploy to Vercel in TEST mode first; set the webhook; confirm a signed `charge.success` secures a payment end to end; confirm `transfer.*` events arrive.
- [ ] Run `npm run reconcile` daily (manually at first, then scheduled) and act on every line it prints. Check `GET /admin/attention` daily.
- [ ] Decide who handles: late payments held in suspense, disputes, refunds (no refunds endpoint yet), failed payouts, reversal-after-paid flags. Write the runbook.
- [ ] Monitoring and alerts for 5xx, webhook failures, payment errors (PRD §150); an on-call person; a status page.
- [ ] Rate limiting behind Vercel: confirm `X-Forwarded-For` cannot be spoofed (DEPLOY.md "Known unknowns").
- [ ] Support channel and a way for users to report a safety incident or a scam.

## D. Product gaps to accept or close before launch
- Refunds endpoint and automatic dispute/chargeback handling (events are only logged, D54).
- Payout fee modelling, per-provider payout limits, scheduled/automatic payouts (all payouts need admin approval today, D56).
- File storage for evidence (photos/documents), notifications, chat API (Step 4).
- Recipient types other than Nigerian bank accounts (D57); currencies other than NGN need markets configured.
- Reputation/verification framework (PRD §88-94).

## E. Launch gate (all must be true)
- [ ] `npm run test:all` green on a fresh database, `live:paystack` and `live:payout` passed in TEST mode, `reconcile` clean.
- [ ] Section A fully closed in writing. Section B done. Section C runbook exists.
- [ ] A staged launch: a handful of known providers/customers, low amount caps, admin-approved payouts, daily reconciliation, for at least a few weeks.
