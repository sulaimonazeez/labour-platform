import { sql } from "drizzle-orm";
import {
  boolean, char, check, date, index, integer, jsonb, numeric, pgTable, text,
  timestamp, unique, uuid,
} from "drizzle-orm/pg-core";
import { createdAt, minor, pk, updatedAt } from "./_common";
import { currencies, markets } from "./config";
import { providerProfiles, users } from "./identity";
import { projects } from "./projects";
import { milestones } from "./delivery";
import { serviceCategories } from "./taxonomy";
import {
  actorType, ledgerAccountKind, ledgerDirection, ledgerEntryKind, paymentState, payoutState,
} from "./enums";

// Payment state is deliberately separate from task/milestone state (PRD §135).
export const payments = pgTable("payments", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  milestoneId: uuid("milestone_id").references(() => milestones.id),
  payerUserId: uuid("payer_user_id").notNull().references(() => users.id),
  amountMinor: minor("amount_minor").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  state: paymentState("state").notNull().default("created"),
  providerCode: text("provider_code").notNull(),
  methodCode: text("method_code"),
  providerReference: text("provider_reference"),
  releasedMinor: minor("released_minor").notNull().default(0),
  refundedMinor: minor("refunded_minor").notNull().default(0),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check("payments_amount_chk", sql`${t.amountMinor} > 0`),
  check("payments_bounds_chk", sql`${t.releasedMinor} >= 0 and ${t.refundedMinor} >= 0 and ${t.releasedMinor} + ${t.refundedMinor} <= ${t.amountMinor}`),
  unique("payments_provider_ref_uniq").on(t.providerCode, t.providerReference),
  index("payments_project_idx").on(t.projectId, t.state),
]);

export const payouts = pgTable("payouts", {
  id: pk(),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id),
  amountMinor: minor("amount_minor").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  state: payoutState("state").notNull().default("pending"),
  providerCode: text("provider_code").notNull(),
  providerReference: text("provider_reference"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  failureReason: text("failure_reason"),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check("payouts_amount_chk", sql`${t.amountMinor} > 0`),
  index("payouts_provider_idx").on(t.providerProfileId, t.state),
  unique("payouts_provider_ref_uniq").on(t.providerCode, t.providerReference),
]);

// Where a provider is paid (PRD §125). The full account number is NEVER stored: only the gateway's recipient code,
// the last 4 digits (for display) and the name the bank returned. One account per provider; changing it starts a cooldown.
export const providerPayoutAccounts = pgTable("provider_payout_accounts", {
  id: pk(),
  providerProfileId: uuid("provider_profile_id").notNull().unique().references(() => providerProfiles.id),
  providerCode: text("provider_code").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  bankCode: text("bank_code").notNull(),
  accountLast4: text("account_last4").notNull(),
  accountName: text("account_name").notNull(),
  recipientCode: text("recipient_code").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [check("payout_accounts_last4_chk", sql`char_length(${t.accountLast4}) = 4`)]);

export const platformFeeRules = pgTable("platform_fee_rules", {
  id: pk(),
  marketId: uuid("market_id").references(() => markets.id),
  categoryId: uuid("category_id").references(() => serviceCategories.id),
  basisPoints: integer("basis_points").notNull(),
  minFeeMinor: minor("min_fee_minor"),
  maxFeeMinor: minor("max_fee_minor"),
  currency: char("currency", { length: 3 }).references(() => currencies.code),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [check("platform_fee_rules_bps_chk", sql`${t.basisPoints} between 0 and 10000`)]);

// ---- Double-entry ledger (PRD §50). Balances are DERIVED from lines, never stored. ----

// owner_key examples: 'platform', 'user:<uuid>', 'provider:<uuid>', 'project:<uuid>'
export const ledgerAccounts = pgTable("ledger_accounts", {
  id: pk(),
  kind: ledgerAccountKind("kind").notNull(),
  ownerKey: text("owner_key").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  createdAt: createdAt(),
}, (t) => [unique("ledger_accounts_uniq").on(t.kind, t.ownerKey, t.currency)]);

export const ledgerEntries = pgTable("ledger_entries", {
  id: pk(),
  kind: ledgerEntryKind("kind").notNull(),
  projectId: uuid("project_id").references(() => projects.id),
  milestoneId: uuid("milestone_id").references(() => milestones.id),
  paymentId: uuid("payment_id").references(() => payments.id),
  payoutId: uuid("payout_id").references(() => payouts.id),
  description: text("description"),
  idempotencyKey: text("idempotency_key").notNull().unique(), // replays can never double-post
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ledger_entries_project_idx").on(t.projectId)]);

export const ledgerLines = pgTable("ledger_lines", {
  id: pk(),
  entryId: uuid("entry_id").notNull().references(() => ledgerEntries.id),
  accountId: uuid("account_id").notNull().references(() => ledgerAccounts.id),
  direction: ledgerDirection("direction").notNull(),
  amountMinor: minor("amount_minor").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
}, (t) => [
  check("ledger_lines_amount_chk", sql`${t.amountMinor} > 0`),
  index("ledger_lines_entry_idx").on(t.entryId),
  index("ledger_lines_account_idx").on(t.accountId),
]);

// PRD §46
export const fxConversions = pgTable("fx_conversions", {
  id: pk(),
  ledgerEntryId: uuid("ledger_entry_id").notNull().references(() => ledgerEntries.id),
  sourceAmountMinor: minor("source_amount_minor").notNull(),
  sourceCurrency: char("source_currency", { length: 3 }).notNull().references(() => currencies.code),
  destAmountMinor: minor("dest_amount_minor").notNull(),
  destCurrency: char("dest_currency", { length: 3 }).notNull().references(() => currencies.code),
  rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
  rateSource: text("rate_source").notNull(),
  rateAt: timestamp("rate_at", { withTimezone: true }).notNull(),
  feeMinor: minor("fee_minor").notNull().default(0),
  feeCurrency: char("fee_currency", { length: 3 }).references(() => currencies.code),
});
