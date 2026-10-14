import { sql } from "drizzle-orm";
import {
  boolean, char, check, date, index, integer, jsonb, numeric, pgTable, primaryKey, smallint,
  text, timestamp, unique, uuid,
} from "drizzle-orm/pg-core";
import { createdAt, minor, pk, updatedAt } from "./_common.js";
import { currencies, languages, markets } from "./config.js";
import { organisations, providerProfiles, users } from "./identity.js";
import { projects, requests, tasks } from "./projects.js";
import { assignments } from "./quotes.js";
import { conversations, messages } from "./chat.js";
import { notificationChannel, orgRole, paymentState } from "./enums.js";

// ──────────────────────────────────────────────────────────────────────────────
// The blueprint layer: every PRD domain that was not yet a table.
// Rules kept on purpose:
//  - Every FK to users / projects / tasks / provider_profiles either cascades or sets null, so the existing test
//    cleanup (which deletes users, projects and profiles) keeps working.
//  - Status-like columns are TEXT validated by zod in the routes, so a market or programme can add a state without a
//    migration (PRD §2, §126: configuration, not forks). Money is minor units + explicit currency (PRD §45).
//  - No new append-only triggers: they would block cascade deletes. Immutability is enforced by having no update route.
// ──────────────────────────────────────────────────────────────────────────────

// ── AI, templates, drafts (PRD §16-23, §105-108, §149) ───────────────────────
export const projectTemplates = pgTable("project_templates", {
  id: pk(),
  key: text("key").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  categoryKey: text("category_key"), // canonical key (PRD §24); not an FK so a template can exist before its category
  ownerKind: text("owner_kind").notNull().default("platform"), // platform|expert|professional_body|business|government|programme|private
  ownerOrganisationId: uuid("owner_organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  visibility: text("visibility").notNull().default("global"), // global|market|organisation|private
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("project_templates_category_idx").on(t.categoryKey)]);

// PRD §23: version, source, geography, regulations, language, effective date, approval state, superseded status.
export const templateVersions = pgTable("template_versions", {
  id: pk(),
  templateId: uuid("template_id").notNull().references(() => projectTemplates.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  language: text("language").notNull().references(() => languages.code),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  sourceKind: text("source_kind").notNull().default("platform"), // platform|verified_expert|professional_body|business|government|programme|approved_project|ai_validated
  authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
  marketCodes: text("market_codes").array().notNull().default(sql`'{}'::text[]`), // empty = every market
  regulations: text("regulations").array().notNull().default(sql`'{}'::text[]`),
  effectiveFrom: date("effective_from"),
  approvalState: text("approval_state").notNull().default("draft"), // draft|in_review|approved|rejected|superseded
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  supersededByVersionId: uuid("superseded_by_version_id"),
  createdAt: createdAt(),
}, (t) => [
  unique("template_versions_uniq").on(t.templateId, t.version),
  index("template_versions_state_idx").on(t.templateId, t.approvalState),
]);

export const aiInteractions = pgTable("ai_interactions", {
  id: pk(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  purpose: text("purpose").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  status: text("status").notNull(), // ok|error|disabled|quota|blocked
  inputChars: integer("input_chars").notNull().default(0),
  outputChars: integer("output_chars").notNull().default(0),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costMicros: minor("cost_micros").notNull().default(0),
  latencyMs: integer("latency_ms"),
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("ai_interactions_user_idx").on(t.userId, t.createdAt)]);

export const aiUsageDaily = pgTable("ai_usage_daily", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  calls: integer("calls").notNull().default(0),
  costMicros: minor("cost_micros").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.userId, t.day] })]);

// PRD §19-20: generate -> validate -> review -> accept -> persist. A draft is a proposal, never a project.
export const projectDrafts = pgTable("project_drafts", {
  id: pk(),
  requestId: uuid("request_id").references(() => requests.id, { onDelete: "cascade" }),
  requesterUserId: uuid("requester_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  templateVersionId: uuid("template_version_id").references(() => templateVersions.id, { onDelete: "set null" }),
  source: text("source").notNull(), // template|ai|rules|manual
  status: text("status").notNull().default("validated"), // validated|accepted|rejected
  language: text("language"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  aiInteractionId: uuid("ai_interaction_id").references(() => aiInteractions.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => [index("project_drafts_requester_idx").on(t.requesterUserId, t.status)]);

// ── Communication (PRD §28-35, §98) ──────────────────────────────────────────
export const conversationReads = pgTable("conversation_reads", {
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.conversationId, t.userId] })]);

// PRD §30 "Confirm Understanding" for consequential, translated messages.
export const messageConfirmations = pgTable("message_confirmations", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.messageId, t.userId] })]);

// PRD §35: voice notes keep the recording (message.attachments) and get a transcript with provenance.
export const messageTranscripts = pgTable("message_transcripts", {
  messageId: uuid("message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  language: text("language"),
  text: text("text").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  createdAt: createdAt(),
});

export const moderationReports = pgTable("moderation_reports", {
  id: pk(),
  reporterUserId: uuid("reporter_user_id").references(() => users.id, { onDelete: "set null" }), // null = automatic flag
  targetType: text("target_type").notNull(), // message|user|provider|listing
  targetId: uuid("target_id").notNull(),
  reason: text("reason").notNull(), // spam|harassment|threat|fraud|prohibited|impersonation|contact_leak|payment_manipulation|other
  detail: text("detail"),
  status: text("status").notNull().default("open"), // open|actioned|dismissed
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [index("moderation_reports_status_idx").on(t.status, t.createdAt)]);

// ── Scheduling (PRD §41-43, §71-75) ──────────────────────────────────────────
export const providerAvailability = pgTable("provider_availability", {
  id: pk(),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  weekday: smallint("weekday").notNull(), // 0=Sunday..6=Saturday, never assumed Mon-Fri (PRD §43)
  startMinute: smallint("start_minute").notNull(),
  endMinute: smallint("end_minute").notNull(),
  timezone: text("timezone").notNull(),
}, (t) => [
  check("provider_availability_chk", sql`${t.weekday} between 0 and 6 and ${t.startMinute} between 0 and 1439 and ${t.endMinute} between 1 and 1440 and ${t.endMinute} > ${t.startMinute}`),
  index("provider_availability_idx").on(t.providerProfileId, t.weekday),
]);

export const availabilityExceptions = pgTable("availability_exceptions", {
  id: pk(),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  reason: text("reason"),
}, (t) => [check("availability_exceptions_chk", sql`${t.endsAt} > ${t.startsAt}`)]);

export const cancellationPolicies = pgTable("cancellation_policies", {
  id: pk(),
  key: text("key").notNull().unique(),
  marketId: uuid("market_id").references(() => markets.id, { onDelete: "cascade" }),
  categoryKey: text("category_key"),
  rules: jsonb("rules").$type<{ hoursBefore: number; feePercent: number }[]>().notNull().default([]),
  noShow: jsonb("no_show").$type<Record<string, unknown>>().notNull().default({}),
  description: text("description"),
  createdAt: createdAt(),
});

export const bookings = pgTable("bookings", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  assignmentId: uuid("assignment_id").references(() => assignments.id, { onDelete: "set null" }),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("proposed"), // proposed|confirmed|rescheduled|cancelled|completed|no_show_provider|no_show_customer
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  travelBufferMin: integer("travel_buffer_min").notNull().default(0),
  cancellationPolicyKey: text("cancellation_policy_key"), // defined BEFORE the booking is confirmed (PRD §74)
  proposedByUserId: uuid("proposed_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  note: text("note"),
  cancelledReason: text("cancelled_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check("bookings_time_chk", sql`${t.endsAt} > ${t.startsAt}`),
  index("bookings_provider_idx").on(t.providerProfileId, t.startsAt),
  index("bookings_task_idx").on(t.taskId),
]);

// PRD §73: optional, coarse. Coordinates are rounded by the route; nothing continuous is stored.
export const checkIns = pgTable("check_ins", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // en_route|arrived|started|left
  etaMinutes: integer("eta_minutes"),
  approxLat: numeric("approx_lat", { precision: 8, scale: 3 }),
  approxLng: numeric("approx_lng", { precision: 9, scale: 3 }),
  createdAt: createdAt(),
}, (t) => [index("check_ins_task_idx").on(t.taskId, t.createdAt)]);

// ── Organisations, budgets, approvals, SLAs, facilities (PRD §7-8, §76, §114-118) ─
export const orgDepartments = pgTable("org_departments", {
  id: pk(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: createdAt(),
}, (t) => [unique("org_departments_uniq").on(t.organisationId, t.name)]);

export const costCentres = pgTable("cost_centres", {
  id: pk(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  departmentId: uuid("department_id").references(() => orgDepartments.id, { onDelete: "set null" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
}, (t) => [unique("cost_centres_uniq").on(t.organisationId, t.code)]);

// A location or branch (PRD §7, §117). Address shape follows the market, never a fixed structure (PRD §39).
export const orgSites = pgTable("org_sites", {
  id: pk(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  departmentId: uuid("department_id").references(() => orgDepartments.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  address: jsonb("address").$type<Record<string, unknown>>().notNull().default({}),
  regionRef: text("region_ref"),
  timezone: text("timezone"),
  createdAt: createdAt(),
}, (t) => [unique("org_sites_uniq").on(t.organisationId, t.name)]);

export const orgBudgets = pgTable("org_budgets", {
  id: pk(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  departmentId: uuid("department_id").references(() => orgDepartments.id, { onDelete: "set null" }),
  costCentreId: uuid("cost_centre_id").references(() => costCentres.id, { onDelete: "set null" }),
  label: text("label").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  amountMinor: minor("amount_minor").notNull(),
  spendLimitMinor: minor("spend_limit_minor"), // per-transaction ceiling (PRD §116)
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  createdAt: createdAt(),
}, (t) => [check("org_budgets_chk", sql`${t.amountMinor} >= 0 and ${t.periodEnd} >= ${t.periodStart}`)]);

export const approvalPolicies = pgTable("approval_policies", {
  id: pk(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  subjectType: text("subject_type").notNull(), // quote|project|change|procurement|payment|milestone
  thresholdMinor: minor("threshold_minor").notNull().default(0),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  requiredRole: orgRole("required_role").notNull().default("finance_approver"),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [index("approval_policies_org_idx").on(t.organisationId, t.subjectType)]);

export const approvalRequests = pgTable("approval_requests", {
  id: pk(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  amountMinor: minor("amount_minor").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  requiredRole: orgRole("required_role"),
  status: text("status").notNull().default("pending"), // pending|approved|rejected|not_required
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  note: text("note"),
  createdAt: createdAt(),
}, (t) => [index("approval_requests_org_idx").on(t.organisationId, t.status), index("approval_requests_subject_idx").on(t.subjectType, t.subjectId)]);

export const orgPreferredProviders = pgTable("org_preferred_providers", {
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  categoryKey: text("category_key").notNull().default(""),
  note: text("note"),
}, (t) => [primaryKey({ columns: [t.organisationId, t.providerProfileId, t.categoryKey] })]);

export const slaPolicies = pgTable("sla_policies", {
  id: pk(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  categoryKey: text("category_key"),
  responseMinutes: integer("response_minutes"),
  arrivalMinutes: integer("arrival_minutes"),
  resolutionMinutes: integer("resolution_minutes"),
  completionHours: integer("completion_hours"),
  escalation: jsonb("escalation").$type<{ afterMinutes: number; notifyRole: string }[]>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
});

// PRD §118: each occurrence generates a project (a service order) with the task template.
export const recurringServices = pgTable("recurring_services", {
  id: pk(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: uuid("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  siteId: uuid("site_id").references(() => orgSites.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  categoryKey: text("category_key"),
  frequency: text("frequency").notNull(), // daily|weekly|monthly|quarterly|annual|custom
  intervalCount: integer("interval_count").notNull().default(1),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
  nextDueOn: date("next_due_on").notNull(),
  timezone: text("timezone").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  marketId: uuid("market_id").notNull().references(() => markets.id),
  taskTemplate: jsonb("task_template").$type<{ title: string; description?: string }[]>().notNull().default([]),
  preferredProviderProfileId: uuid("preferred_provider_profile_id").references(() => providerProfiles.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("recurring_services_due_idx").on(t.isActive, t.nextDueOn), check("recurring_services_interval_chk", sql`${t.intervalCount} >= 1`)]);

export const recurringOccurrences = pgTable("recurring_occurrences", {
  id: pk(),
  recurringServiceId: uuid("recurring_service_id").notNull().references(() => recurringServices.id, { onDelete: "cascade" }),
  dueOn: date("due_on").notNull(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  status: text("status").notNull().default("generated"), // generated|skipped
  createdAt: createdAt(),
}, (t) => [unique("recurring_occurrences_uniq").on(t.recurringServiceId, t.dueOn)]);

// ── Updates, issues, safety, documents (PRD §65, §78-79, §138) ───────────────
export const projectUpdates = pgTable("project_updates", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("progress"), // progress|blocker|material_request|note
  body: text("body").notNull(),
  language: text("language"),
  createdAt: createdAt(),
}, (t) => [index("project_updates_project_idx").on(t.projectId, t.createdAt)]);

export const issues = pgTable("issues", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category").notNull().default("other"), // material_unavailable|site_inaccessible|safety_risk|defective_equipment|provider_delay|dependency_blocked|other
  severity: text("severity").notNull().default("medium"), // low|medium|high|critical
  status: text("status").notNull().default("open"), // open|acknowledged|resolved|closed
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  affectedTaskIds: uuid("affected_task_ids").array().notNull().default(sql`'{}'::uuid[]`),
  dueAt: timestamp("due_at", { withTimezone: true }),
  resolution: text("resolution"),
  raisedByUserId: uuid("raised_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [index("issues_project_idx").on(t.projectId, t.status)]);

// PRD §79: dedicated reporting, never buried in ordinary chat.
export const safetyIncidents = pgTable("safety_incidents", {
  id: pk(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  reporterUserId: uuid("reporter_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  category: text("category").notNull(), // personal_injury|property_damage|electrical_hazard|fire|equipment_damage|security_concern|unsafe_site
  severity: text("severity").notNull().default("medium"),
  description: text("description").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull().default("reported"), // reported|under_review|closed
  emergencyServicesContacted: boolean("emergency_services_contacted").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("safety_incidents_status_idx").on(t.status, t.createdAt)]);

export const projectDocuments = pgTable("project_documents", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  uploaderUserId: uuid("uploader_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("other"), // specification|drawing|invoice|receipt|contract|certificate|inspection_report|warranty|manual|other
  storagePath: text("storage_path"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  version: integer("version").notNull().default(1),
  supersedesDocumentId: uuid("supersedes_document_id"),
  managersOnly: boolean("managers_only").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index("project_documents_project_idx").on(t.projectId, t.kind)]);

// ── Disputes (PRD §101-104) ──────────────────────────────────────────────────
export const disputes = pgTable("disputes", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull(), // task|milestone|quote|payment|merchant_order|other
  scopeId: uuid("scope_id"),
  openedByUserId: uuid("opened_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  againstUserId: uuid("against_user_id").references(() => users.id, { onDelete: "set null" }),
  reason: text("reason").notNull(),
  description: text("description"),
  amountMinor: minor("amount_minor"),
  currency: char("currency", { length: 3 }).references(() => currencies.code),
  status: text("status").notNull().default("open"), // open|awaiting_response|in_review|resolved|closed
  priorScopeStatus: text("prior_scope_status"), // restored when a frozen milestone is released from dispute
  resolutionKind: text("resolution_kind"), // release|refund|partial|withdrawn|other
  resolution: text("resolution"),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [index("disputes_project_idx").on(t.projectId, t.status), index("disputes_scope_idx").on(t.scopeType, t.scopeId)]);

// PRD §104: facts and claims stay distinguishable. Entries are never edited (there is no update route).
export const disputeEntries = pgTable("dispute_entries", {
  id: pk(),
  disputeId: uuid("dispute_id").notNull().references(() => disputes.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // claim|response|note|proposal|decision
  body: text("body").notNull(),
  language: text("language"),
  createdAt: createdAt(),
}, (t) => [index("dispute_entries_idx").on(t.disputeId, t.createdAt)]);

// ── Trust: insurance, subcontracting, teams (PRD §11-12, §81, §90) ───────────
export const insuranceRecords = pgTable("insurance_records", {
  id: pk(),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // professional_indemnity|public_liability|worker|vehicle|project
  insurer: text("insurer"),
  policyRef: text("policy_ref"),
  coverMinor: minor("cover_minor"),
  currency: char("currency", { length: 3 }).references(() => currencies.code),
  expiresOn: date("expires_on").notNull(),
  status: text("status").notNull().default("pending"), // pending|verified|rejected|expired
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("insurance_records_provider_idx").on(t.providerProfileId, t.kind)]);

export const subcontractRequests = pgTable("subcontract_requests", {
  id: pk(),
  assignmentId: uuid("assignment_id").notNull().references(() => assignments.id, { onDelete: "cascade" }),
  requestedByProviderId: uuid("requested_by_provider_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  subcontractorProviderId: uuid("subcontractor_provider_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  status: text("status").notNull().default("pending"), // pending|approved|rejected|withdrawn
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("subcontract_requests_assignment_idx").on(t.assignmentId)]);

export const providerTeams = pgTable("provider_teams", {
  id: pk(),
  name: text("name").notNull(),
  leaderProviderProfileId: uuid("leader_provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

export const providerTeamMembers = pgTable("provider_team_members", {
  teamId: uuid("team_id").notNull().references(() => providerTeams.id, { onDelete: "cascade" }),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  revenueShareBps: integer("revenue_share_bps").notNull().default(0),
  permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.teamId, t.providerProfileId] }),
  check("provider_team_members_share_chk", sql`${t.revenueShareBps} between 0 and 10000`),
]);

// ── Commerce, procurement, assets, warranties (PRD §13, §51, §63-64, §82-86, §123) ─
export const merchants = pgTable("merchants", {
  id: pk(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: uuid("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  marketId: uuid("market_id").references(() => markets.id, { onDelete: "set null" }),
  displayName: text("display_name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique("merchants_owner_uniq").on(t.ownerUserId)]);

export const products = pgTable("products", {
  id: pk(),
  merchantId: uuid("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  categoryKey: text("category_key"),
  priceMinor: minor("price_minor").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  stock: integer("stock"), // null = not tracked
  warrantyMonths: smallint("warranty_months").notNull().default(0),
  attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique("products_sku_uniq").on(t.merchantId, t.sku), check("products_price_chk", sql`${t.priceMinor} >= 0`)]);

// PRD §51: product orders and service contracts share a project but never a payment, refund, dispute or tax state.
export const merchantOrders = pgTable("merchant_orders", {
  id: pk(),
  buyerUserId: uuid("buyer_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  merchantId: uuid("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  status: text("status").notNull().default("created"), // created|confirmed|shipped|delivered|accepted|cancelled|disputed
  paymentState: paymentState("payment_state").notNull().default("created"), // collection plugs into the payment orchestration layer
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  subtotalMinor: minor("subtotal_minor").notNull(),
  taxMinor: minor("tax_minor").notNull().default(0),
  totalMinor: minor("total_minor").notNull(),
  taxBreakdown: jsonb("tax_breakdown").$type<{ code: string; rateBps: number; amountMinor: number }[]>().notNull().default([]),
  delivery: jsonb("delivery").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("merchant_orders_buyer_idx").on(t.buyerUserId, t.status), index("merchant_orders_merchant_idx").on(t.merchantId, t.status)]);

export const merchantOrderItems = pgTable("merchant_order_items", {
  id: pk(),
  orderId: uuid("order_id").notNull().references(() => merchantOrders.id, { onDelete: "cascade" }),
  productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceMinor: minor("unit_price_minor").notNull(),
  amountMinor: minor("amount_minor").notNull(),
}, (t) => [check("merchant_order_items_qty_chk", sql`${t.quantity} >= 1`)]);

export const procurementRequests = pgTable("procurement_requests", {
  id: pk(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  specification: text("specification").notNull(),
  quantity: integer("quantity").notNull().default(1),
  status: text("status").notNull().default("need_identified"), // need_identified|quoting|approved|ordered|delivered|accepted|cancelled
  orderId: uuid("order_id").references(() => merchantOrders.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("procurement_requests_project_idx").on(t.projectId, t.status)]);

export const procurementQuotes = pgTable("procurement_quotes", {
  id: pk(),
  procurementRequestId: uuid("procurement_request_id").notNull().references(() => procurementRequests.id, { onDelete: "cascade" }),
  merchantId: uuid("merchant_id").notNull().references(() => merchants.id, { onDelete: "cascade" }),
  productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
  unitPriceMinor: minor("unit_price_minor").notNull(),
  currency: char("currency", { length: 3 }).notNull().references(() => currencies.code),
  leadDays: integer("lead_days"),
  note: text("note"),
  status: text("status").notNull().default("submitted"), // submitted|selected|rejected
  createdAt: createdAt(),
}, (t) => [unique("procurement_quotes_uniq").on(t.procurementRequestId, t.merchantId)]);

export const assets = pgTable("assets", {
  id: pk(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: uuid("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  siteId: uuid("site_id").references(() => orgSites.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  kind: text("kind").notNull(), // building|vehicle|equipment|hvac|solar_system|appliance|lock|machinery|other
  name: text("name").notNull(),
  model: text("model"),
  serial: text("serial"),
  installedOn: date("installed_on"),
  installedByProviderProfileId: uuid("installed_by_provider_profile_id").references(() => providerProfiles.id, { onDelete: "set null" }),
  locationNote: text("location_note"),
  nextServiceOn: date("next_service_on"),
  attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("assets_owner_idx").on(t.ownerUserId), index("assets_next_service_idx").on(t.nextServiceOn)]);

export const assetServiceHistory = pgTable("asset_service_history", {
  id: pk(),
  assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  performedOn: date("performed_on").notNull(),
  summary: text("summary").notNull(),
  providerProfileId: uuid("provider_profile_id").references(() => providerProfiles.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

// PRD §82: four warranty kinds, kept distinct.
export const warranties = pgTable("warranties", {
  id: pk(),
  assetId: uuid("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // workmanship|manufacturer|merchant|platform
  grantor: text("grantor"),
  providerProfileId: uuid("provider_profile_id").references(() => providerProfiles.id, { onDelete: "set null" }),
  merchantId: uuid("merchant_id").references(() => merchants.id, { onDelete: "set null" }),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  terms: text("terms"),
  createdAt: createdAt(),
}, (t) => [check("warranties_dates_chk", sql`${t.endsOn} >= ${t.startsOn}`), index("warranties_owner_idx").on(t.ownerUserId, t.endsOn)]);

export const warrantyClaims = pgTable("warranty_claims", {
  id: pk(),
  warrantyId: uuid("warranty_id").notNull().references(() => warranties.id, { onDelete: "cascade" }),
  claimantUserId: uuid("claimant_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  status: text("status").notNull().default("open"), // open|accepted|rejected|resolved
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Institutions: programmes and registries (PRD §8, §119-122) ───────────────
export const programmes = pgTable("programmes", {
  id: pk(),
  organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  region: text("region"),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  goals: jsonb("goals").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [unique("programmes_uniq").on(t.organisationId, t.name)]);

// PRD §122: training -> assessment -> verification -> listing -> real work. PII stays behind org roles (PRD §119).
export const programmeParticipants = pgTable("programme_participants", {
  programmeId: uuid("programme_id").notNull().references(() => programmes.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("enrolled"), // enrolled|trained|assessed|verified|listed|working|graduated|withdrawn
  assessment: jsonb("assessment").$type<Record<string, unknown>>().notNull().default({}),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.programmeId, t.userId] })]);

// ── Platform: flags, notification preferences, privacy, retention, promotion, events (PRD §97, §112-113, §130-131, §150-151) ─
export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(false),
  scope: jsonb("scope").$type<{ markets?: string[]; organisations?: string[]; categories?: string[]; rolloutPercent?: number }>().notNull().default({}),
  updatedAt: updatedAt(),
});

export const notificationPreferences = pgTable("notification_preferences", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  channel: notificationChannel("channel").notNull(),
  kindPrefix: text("kind_prefix").notNull().default(""), // "" = every kind
  enabled: boolean("enabled").notNull().default(true),
  quietStart: text("quiet_start"), // "22:00" in the user's own time zone
  quietEnd: text("quiet_end"),
}, (t) => [primaryKey({ columns: [t.userId, t.channel, t.kindPrefix] })]);

export const privacyRequests = pgTable("privacy_requests", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // export|delete|restrict
  status: text("status").notNull().default("received"), // received|in_progress|completed|refused
  note: text("note"),
  createdAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [index("privacy_requests_status_idx").on(t.status, t.createdAt)]);

export const retentionPolicies = pgTable("retention_policies", {
  id: pk(),
  dataClass: text("data_class").notNull(), // chats|financial|identity|evidence|disputes|deleted_accounts
  marketId: uuid("market_id").references(() => markets.id, { onDelete: "cascade" }),
  retainDays: integer("retain_days").notNull(),
  note: text("note"),
}, (t) => [index("retention_policies_class_idx").on(t.dataClass)]);

// PRD §97: sponsored visibility. It never overrides qualification, geography, safety or restrictions (enforced in ranking).
export const promotedListings = pgTable("promoted_listings", {
  id: pk(),
  providerProfileId: uuid("provider_profile_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  categoryKey: text("category_key").notNull(),
  marketId: uuid("market_id").references(() => markets.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
}, (t) => [index("promoted_listings_idx").on(t.categoryKey, t.endsAt), check("promoted_listings_chk", sql`${t.endsAt} > ${t.startsAt}`)]);

export const platformEvents = pgTable("platform_events", {
  id: pk(),
  kind: text("kind").notNull(), // ai.failed|translation.failed|payment.error|upload.failed|sla.breach|fraud.signal|job.failed ...
  severity: text("severity").notNull().default("info"), // info|warn|error
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index("platform_events_kind_idx").on(t.kind, t.createdAt)]);
