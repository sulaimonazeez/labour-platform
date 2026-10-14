import { sql } from "drizzle-orm";
import {
  type AnyPgColumn, boolean, char, check, date, index, integer, numeric, pgTable,
  primaryKey, smallint, text, unique, uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_common";
import { languages, markets } from "./config";
import { serviceCategories } from "./taxonomy";
import {
  orgRole, orgType, providerKind, userStatus, verificationClass, verificationStatus,
} from "./enums";

export const users = pgTable("users", {
  id: pk(),
  email: text("email").unique(),
  phone: text("phone").unique(),
  displayName: text("display_name").notNull(),
  // PRD §26 language preferences
  preferredLanguage: text("preferred_language").notNull().references(() => languages.code),
  secondaryLanguages: text("secondary_languages").array().notNull().default(sql`'{}'::text[]`),
  autoTranslate: boolean("auto_translate").notNull().default(true),
  showOriginalByDefault: boolean("show_original_by_default").notNull().default(false),
  timezone: text("timezone").notNull(), // IANA
  marketId: uuid("market_id").references(() => markets.id),
  status: userStatus("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [check("users_contact_chk", sql`${t.email} is not null or ${t.phone} is not null`)]);

export const organisations = pgTable("organisations", {
  id: pk(),
  name: text("name").notNull(),
  type: orgType("type").notNull(),
  marketId: uuid("market_id").references(() => markets.id),
  parentOrganisationId: uuid("parent_organisation_id").references((): AnyPgColumn => organisations.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organisationMembers = pgTable("organisation_members", {
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: orgRole("role").notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.organisationId, t.userId, t.role] })]);

export const providerProfiles = pgTable("provider_profiles", {
  id: pk(),
  userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: "restrict" }),
  organisationId: uuid("organisation_id").references(() => organisations.id),
  kind: providerKind("kind").notNull().default("individual"),
  displayName: text("display_name").notNull(),
  headline: text("headline"),
  bio: text("bio"),
  // PRD §40: only APPROXIMATE location lives on the profile.
  approxLat: numeric("approx_lat", { precision: 9, scale: 6 }),
  approxLng: numeric("approx_lng", { precision: 9, scale: 6 }),
  serviceRadiusKm: integer("service_radius_km"),
  remoteOk: boolean("remote_ok").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const providerServices = pgTable("provider_services", {
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").notNull().references(() => serviceCategories.id),
  pricingApproach: text("pricing_approach"),
  yearsExperience: smallint("years_experience"),
}, (t) => [primaryKey({ columns: [t.providerProfileId, t.categoryId] })]);

// PRD §88-89: class + expiry tracked; country adapters decide acceptable documents.
export const verifications = pgTable("verifications", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  providerProfileId: uuid("provider_profile_id").references(() => providerProfiles.id, { onDelete: "cascade" }),
  verificationClass: verificationClass("verification_class").notNull(),
  status: verificationStatus("status").notNull().default("pending"),
  issuer: text("issuer"),
  marketId: uuid("market_id").references(() => markets.id),
  issuedAt: date("issued_at"),
  expiresAt: date("expires_at"),
  documentRef: text("document_ref"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("verifications_user_class_idx").on(t.userId, t.verificationClass)]);
