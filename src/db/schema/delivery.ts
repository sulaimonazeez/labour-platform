import { sql } from "drizzle-orm";
import {
  bigint, char, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, smallint,
  text, timestamp, unique, uuid,
} from "drizzle-orm/pg-core";
import { createdAt, minor, pk, updatedAt } from "./_common";
import { currencies } from "./config";
import { providerProfiles, users } from "./identity";
import { projects, stages, tasks } from "./projects";
import { assignments } from "./quotes";
import {
  changeFinancialEffect, changeStatus, evidenceKind, milestoneStatus,
} from "./enums";

export const changeRequests = pgTable("change_requests", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
  status: changeStatus("status").notNull().default("draft"),
  title: text("title").notNull(),
  description: text("description"),
  financialEffect: changeFinancialEffect("financial_effect").notNull().default("no_cost"),
  costDeltaMinor: minor("cost_delta_minor").notNull().default(0), // signed
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  scheduleDeltaDays: integer("schedule_delta_days").notNull().default(0),
  baseBaselineVersion: integer("base_baseline_version").notNull(),
  resultingBaselineVersion: integer("resulting_baseline_version"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("change_requests_project_idx").on(t.projectId, t.status)]);

// PRD §59: every accepted change produces a NEW baseline; old ones are never edited.
export const projectBaselines = pgTable("project_baselines", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  createdByChangeRequestId: uuid("created_by_change_request_id"), // set for v>=2
  createdAt: createdAt(),
}, (t) => [
  unique("project_baselines_uniq").on(t.projectId, t.version),
  foreignKey({
    name: "project_baselines_cr_fk",
    columns: [t.createdByChangeRequestId],
    foreignColumns: [changeRequests.id],
  }),
]);

export const changeRequestTasks = pgTable("change_request_tasks", {
  changeRequestId: uuid("change_request_id").notNull().references(() => changeRequests.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.changeRequestId, t.taskId] })]);

export const milestones = pgTable("milestones", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  stageId: uuid("stage_id").references(() => stages.id, { onDelete: "set null" }),
  assignmentId: uuid("assignment_id").references(() => assignments.id),
  title: text("title").notNull(),
  amountMinor: minor("amount_minor").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  dueAt: timestamp("due_at", { withTimezone: true }),
  acceptanceCriteria: text("acceptance_criteria"),
  evidenceRequirements: jsonb("evidence_requirements").$type<Record<string, unknown>>().notNull().default({}),
  approverUserId: uuid("approver_user_id").references(() => users.id),
  status: milestoneStatus("status").notNull().default("pending"),
  position: integer("position").notNull().default(0),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check("milestones_amount_chk", sql`${t.amountMinor} >= 0`),
  index("milestones_project_idx").on(t.projectId, t.status),
]);

// PRD §66-67: append-only. Hash + metadata are recorded but never presented as infallible proof.
export const evidence = pgTable("evidence", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id),
  milestoneId: uuid("milestone_id").references(() => milestones.id),
  uploaderUserId: uuid("uploader_user_id").notNull().references(() => users.id),
  kind: evidenceKind("kind").notNull(),
  storagePath: text("storage_path"), // private bucket path; serve via signed URLs only
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  fileSha256: text("file_sha256"),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  captureMeta: jsonb("capture_meta").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  check("evidence_target_chk", sql`${t.taskId} is not null or ${t.milestoneId} is not null`),
  index("evidence_project_idx").on(t.projectId),
  index("evidence_task_idx").on(t.taskId),
]);

// PRD §91: multi-dimensional, not one star rating.
export const reviews = pgTable("reviews", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  reviewerUserId: uuid("reviewer_user_id").notNull().references(() => users.id),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id),
  workmanship: smallint("workmanship"),
  punctuality: smallint("punctuality"),
  communication: smallint("communication"),
  professionalism: smallint("professionalism"),
  quoteAccuracy: smallint("quote_accuracy"),
  comment: text("comment"),
  createdAt: createdAt(),
}, (t) => [
  unique("reviews_uniq").on(t.projectId, t.reviewerUserId, t.providerProfileId),
  check("reviews_range_chk", sql`
    (${t.workmanship} is null or ${t.workmanship} between 1 and 5) and
    (${t.punctuality} is null or ${t.punctuality} between 1 and 5) and
    (${t.communication} is null or ${t.communication} between 1 and 5) and
    (${t.professionalism} is null or ${t.professionalism} between 1 and 5) and
    (${t.quoteAccuracy} is null or ${t.quoteAccuracy} between 1 and 5)`),
]);
