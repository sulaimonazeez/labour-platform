import { sql } from "drizzle-orm";
import {
  char, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid,
} from "drizzle-orm/pg-core";
import { createdAt, minor, pk, updatedAt } from "./_common";
import { currencies, languages, markets } from "./config";
import { organisations, providerProfiles, users } from "./identity";
import { serviceCategories } from "./taxonomy";
import {
  candidateStatus, dependencyType, materialResponsibility, projectHealth, projectRole,
  projectStatus, requestPath, requestStatus, stageStatus, taskStatus,
} from "./enums";

export const requests = pgTable("requests", {
  id: pk(),
  requesterUserId: uuid("requester_user_id").notNull().references(() => users.id),
  organisationId: uuid("organisation_id").references(() => organisations.id),
  marketId: uuid("market_id").notNull().references(() => markets.id),
  categoryId: uuid("category_id").references(() => serviceCategories.id),
  rawText: text("raw_text"), // what the user actually wrote, untouched
  originalLanguage: text("original_language").references(() => languages.code),
  path: requestPath("path").notNull().default("quick_service"),
  status: requestStatus("status").notNull().default("draft"),
  siteLocation: jsonb("site_location").$type<Record<string, unknown>>(), // market-specific address shape
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("requests_requester_idx").on(t.requesterUserId, t.status)]);

// PRD §95: controlled candidate pool instead of broadcasting.
export const requestCandidates = pgTable("request_candidates", {
  requestId: uuid("request_id").notNull().references(() => requests.id, { onDelete: "cascade" }),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  status: candidateStatus("status").notNull().default("invited"),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.requestId, t.providerProfileId] })]);

export const projects = pgTable("projects", {
  id: pk(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  organisationId: uuid("organisation_id").references(() => organisations.id),
  requestId: uuid("request_id").references(() => requests.id),
  marketId: uuid("market_id").notNull().references(() => markets.id),
  title: text("title").notNull(),
  objective: text("objective"),
  status: projectStatus("status").notNull().default("draft"),
  health: projectHealth("health").notNull().default("on_track"),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  timezone: text("timezone").notNull(), // project/site timezone (IANA)
  currentBaselineVersion: integer("current_baseline_version").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [index("projects_owner_idx").on(t.ownerUserId, t.status)]);

export const projectMembers = pgTable("project_members", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: projectRole("role").notNull(),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.userId, t.role] }),
  index("project_members_user_idx").on(t.userId),
]);

export const stages = pgTable("stages", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  status: stageStatus("status").notNull().default("pending"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("stages_project_idx").on(t.projectId, t.position)]);

export const tasks = pgTable("tasks", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  stageId: uuid("stage_id").references(() => stages.id, { onDelete: "set null" }),
  categoryId: uuid("category_id").references(() => serviceCategories.id),
  title: text("title").notNull(),
  description: text("description"),
  status: taskStatus("status").notNull().default("draft"),
  materialResponsibility: materialResponsibility("material_responsibility").notNull().default("not_applicable"),
  evidenceRequirements: jsonb("evidence_requirements").$type<Record<string, unknown>>().notNull().default({}),
  position: integer("position").notNull().default(0),
  plannedStart: timestamp("planned_start", { withTimezone: true }),
  plannedEnd: timestamp("planned_end", { withTimezone: true }),
  actualStart: timestamp("actual_start", { withTimezone: true }),
  actualEnd: timestamp("actual_end", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("tasks_project_status_idx").on(t.projectId, t.status)]);

// Cycle prevention is enforced in the engine (deterministic graph check), not here.
export const taskDependencies = pgTable("task_dependencies", {
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  dependsOnTaskId: uuid("depends_on_task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  type: dependencyType("type").notNull().default("finish_to_start"),
}, (t) => [
  primaryKey({ columns: [t.taskId, t.dependsOnTaskId, t.type] }),
  check("task_dependencies_self_chk", sql`${t.taskId} <> ${t.dependsOnTaskId}`),
]);

// PRD §56: only the stored baseline numbers live here; committed/paid/pending/etc.
// are derived from quotes + ledger so they can never drift.
export const projectBudgets = pgTable("project_budgets", {
  projectId: uuid("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  estimatedMinor: minor("estimated_minor"),
  approvedMinor: minor("approved_minor"),
  updatedAt: updatedAt(),
});
