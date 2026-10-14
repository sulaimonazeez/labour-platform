import { sql } from "drizzle-orm";
import {
  type AnyPgColumn, boolean, char, check, date, index, integer, jsonb, pgTable,
  primaryKey, smallint, text, unique, uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_common.js";
import { measurementSystem, verificationClass } from "./enums.js";
import { serviceCategories } from "./taxonomy.js";

export const languages = pgTable("languages", {
  code: text("code").primaryKey(), // BCP-47, e.g. en, fr-CA, ar
  nameNative: text("name_native").notNull(),
  nameEnglish: text("name_english").notNull(),
  direction: text("direction").notNull().default("ltr"),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [check("languages_direction_chk", sql`${t.direction} in ('ltr','rtl')`)]);

export const currencies = pgTable("currencies", {
  code: char("code", { length: 3 }).primaryKey(), // ISO 4217
  name: text("name").notNull(),
  minorUnitExponent: smallint("minor_unit_exponent").notNull().default(2), // JPY 0, KWD 3
  isActive: boolean("is_active").notNull().default(true),
});

// PRD §127-128: markets form a tree (global default -> country -> region).
export const markets = pgTable("markets", {
  id: pk(),
  code: text("code").notNull().unique(), // e.g. NG, NG-LA
  parentMarketId: uuid("parent_market_id").references((): AnyPgColumn => markets.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  defaultLanguage: text("default_language").notNull().references(() => languages.code),
  defaultCurrency: char("default_currency", { length: 3 }).notNull().references(() => currencies.code),
  defaultTimezone: text("default_timezone").notNull(), // IANA
  measurementSystem: measurementSystem("measurement_system").notNull(),
  addressFormat: jsonb("address_format").$type<Record<string, unknown>>().notNull().default({}),
  workingDays: jsonb("working_days").$type<number[]>().notNull(), // 0=Sun..6=Sat; explicit per market
  businessHours: jsonb("business_hours").$type<Record<string, unknown>>(),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const marketLanguages = pgTable("market_languages", {
  marketId: uuid("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  languageCode: text("language_code").notNull().references(() => languages.code),
  isDefault: boolean("is_default").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.marketId, t.languageCode] })]);

export const marketCurrencies = pgTable("market_currencies", {
  marketId: uuid("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  currencyCode: char("currency_code", { length: 3 }).notNull().references(() => currencies.code),
  isDefault: boolean("is_default").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.marketId, t.currencyCode] })]);

export const marketPaymentMethods = pgTable("market_payment_methods", {
  id: pk(),
  marketId: uuid("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  methodCode: text("method_code").notNull(), // card, bank_transfer, mobile_money, wallet...
  providerCode: text("provider_code").notNull(), // adapter key in the payment orchestration layer
  supportsProtectedPayment: boolean("supports_protected_payment").notNull().default(false),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [unique("market_payment_methods_uniq").on(t.marketId, t.methodCode, t.providerCode)]);

export const marketTaxRules = pgTable("market_tax_rules", {
  id: pk(),
  marketId: uuid("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  taxCode: text("tax_code").notNull(),
  rateBps: integer("rate_bps").notNull(),
  appliesTo: jsonb("applies_to").$type<Record<string, unknown>>().notNull().default({}),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
}, (t) => [
  check("market_tax_rules_rate_chk", sql`${t.rateBps} >= 0`),
  index("market_tax_rules_market_idx").on(t.marketId, t.taxCode),
]);

export const marketVerificationRules = pgTable("market_verification_rules", {
  id: pk(),
  marketId: uuid("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  verificationClass: verificationClass("verification_class").notNull(),
  adapterCode: text("adapter_code").notNull(), // country adapter that checks documents
  acceptedDocuments: jsonb("accepted_documents").$type<string[]>().notNull().default([]),
  requiredForPayout: boolean("required_for_payout").notNull().default(false),
}, (t) => [unique("market_verification_rules_uniq").on(t.marketId, t.verificationClass)]);

export const marketServiceRules = pgTable("market_service_rules", {
  id: pk(),
  marketId: uuid("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").notNull().references(() => serviceCategories.id, { onDelete: "cascade" }),
  isAllowed: boolean("is_allowed").notNull().default(true),
  requiredCredentials: jsonb("required_credentials").$type<string[]>(), // null = inherit from category
  protectedPaymentAllowed: boolean("protected_payment_allowed"), // null = inherit from market
  insuranceRequirements: jsonb("insurance_requirements").$type<Record<string, unknown>>(),
}, (t) => [unique("market_service_rules_uniq").on(t.marketId, t.categoryId)]);

export const marketHolidays = pgTable("market_holidays", {
  id: pk(),
  marketId: uuid("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  holidayDate: date("holiday_date").notNull(),
  name: text("name").notNull(),
}, (t) => [unique("market_holidays_uniq").on(t.marketId, t.holidayDate)]);

export const marketComplianceSettings = pgTable("market_compliance_settings", {
  marketId: uuid("market_id").notNull().references(() => markets.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.marketId, t.key] })]);
