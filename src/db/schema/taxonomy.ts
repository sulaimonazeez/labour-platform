import { sql } from "drizzle-orm";
import {
  type AnyPgColumn, boolean, index, jsonb, pgTable, primaryKey, text, unique, uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_common.js";
import { riskLevel } from "./enums.js";

// PRD §24: identity is canonical_key, never a display name.
export const serviceCategories = pgTable("service_categories", {
  id: pk(),
  canonicalKey: text("canonical_key").notNull().unique(), // e.g. electrical_residential_installation
  parentId: uuid("parent_id").references((): AnyPgColumn => serviceCategories.id, { onDelete: "restrict" }),
  meaning: text("meaning").notNull(), // canonical meaning, language-neutral intent
  riskLevel: riskLevel("risk_level").notNull().default("low"),
  requiredCredentials: jsonb("required_credentials").$type<string[]>().notNull().default([]),
  evidenceRequirements: jsonb("evidence_requirements").$type<Record<string, unknown>>().notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("service_categories_parent_idx").on(t.parentId)]);

export const serviceCategoryTranslations = pgTable("service_category_translations", {
  categoryId: uuid("category_id").notNull().references(() => serviceCategories.id, { onDelete: "cascade" }),
  languageCode: text("language_code").notNull(),
  name: text("name").notNull(),
  description: text("description"),
}, (t) => [primaryKey({ columns: [t.categoryId, t.languageCode] })]);

export const serviceCategorySynonyms = pgTable("service_category_synonyms", {
  id: pk(),
  categoryId: uuid("category_id").notNull().references(() => serviceCategories.id, { onDelete: "cascade" }),
  languageCode: text("language_code").notNull(),
  term: text("term").notNull(),
}, (t) => [
  unique("service_category_synonyms_uniq").on(t.categoryId, t.languageCode, t.term),
  index("service_category_synonyms_lookup_idx").on(t.languageCode, t.term),
]);
