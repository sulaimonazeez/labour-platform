import { sql } from "drizzle-orm";
import {
  boolean, char, check, index, integer, numeric, pgTable, primaryKey, text, timestamp, unique,
  uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { createdAt, minor, pk, updatedAt } from "./_common";
import { currencies } from "./config";
import { providerProfiles, users } from "./identity";
import { projects, requests, tasks } from "./projects";
import { assignmentStatus, candidateStatus, quoteLineKind, quoteStatus } from "./enums";

export const quotes = pgTable("quotes", {
  id: pk(),
  requestId: uuid("request_id").references(() => requests.id),
  projectId: uuid("project_id").references(() => projects.id),
  taskId: uuid("task_id").references(() => tasks.id),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id),
  status: quoteStatus("status").notNull().default("draft"),
  latestVersion: integer("latest_version").notNull().default(1),
  acceptedVersion: integer("accepted_version"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check("quotes_target_chk", sql`${t.requestId} is not null or ${t.projectId} is not null`),
  index("quotes_project_idx").on(t.projectId),
  index("quotes_request_idx").on(t.requestId),
]);

// PRD §53: quotes are never overwritten. A version is immutable once submitted_at is set
// (enforced by sql/guards.sql).
export const quoteVersions = pgTable("quote_versions", {
  id: pk(),
  quoteId: uuid("quote_id").notNull().references(() => quotes.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  totalMinor: minor("total_minor").notNull(),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  inspectionRequired: boolean("inspection_required").notNull().default(false),
  exclusions: text("exclusions"),
  notes: text("notes"),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  unique("quote_versions_uniq").on(t.quoteId, t.version),
  check("quote_versions_total_chk", sql`${t.totalMinor} >= 0`),
]);

export const quoteLineItems = pgTable("quote_line_items", {
  id: pk(),
  quoteVersionId: uuid("quote_version_id").notNull().references(() => quoteVersions.id, { onDelete: "cascade" }),
  kind: quoteLineKind("kind").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull().default("1"),
  unitPriceMinor: minor("unit_price_minor").notNull(),
  amountMinor: minor("amount_minor").notNull(),
  isOptional: boolean("is_optional").notNull().default(false),
  position: integer("position").notNull().default(0),
}, (t) => [index("quote_line_items_version_idx").on(t.quoteVersionId)]);

export const assignments = pgTable("assignments", {
  id: pk(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id),
  quoteId: uuid("quote_id").references(() => quotes.id),
  status: assignmentStatus("status").notNull().default("offered"),
  offeredAt: timestamp("offered_at", { withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // At most one live assignment per task.
  uniqueIndex("assignments_one_live_per_task")
    .on(t.taskId)
    .where(sql`${t.status} in ('offered','accepted','active')`),
  index("assignments_provider_idx").on(t.providerProfileId, t.status),
]);

// PRD §95: a task is offered to a controlled pool of providers, not broadcast. A provider may only
// quote on a task they are invited to (DECISIONS D28). Status reuses the PRD §95 candidate states.
export const taskInvitations = pgTable("task_invitations", {
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  status: candidateStatus("status").notNull().default("invited"),
  invitedByUserId: uuid("invited_by_user_id").notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  primaryKey({ columns: [t.taskId, t.providerProfileId] }),
  index("task_invitations_provider_idx").on(t.providerProfileId, t.status),
]);
