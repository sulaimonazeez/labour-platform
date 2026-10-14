import { pgEnum } from "drizzle-orm/pg-core";

export const measurementSystem = pgEnum("measurement_system", ["metric", "imperial", "mixed"]);
export const userStatus = pgEnum("user_status", ["active", "suspended", "closed"]);
export const orgType = pgEnum("org_type", [
  "business", "government", "ngo", "institution", "service_company", "merchant",
]);
export const orgRole = pgEnum("org_role", [
  "owner", "admin", "member", "finance_approver", "procurement_officer", "project_manager", "auditor",
]);
export const providerKind = pgEnum("provider_kind", ["individual", "company", "team"]);
export const riskLevel = pgEnum("risk_level", ["low", "medium", "high", "critical"]);

// PRD §88
export const verificationClass = pgEnum("verification_class", [
  "contact", "identity", "address", "business", "skill",
  "professional_licence", "insurance", "platform_performance",
]);
export const verificationStatus = pgEnum("verification_status", [
  "pending", "verified", "rejected", "expired", "revoked",
]);

export const requestPath = pgEnum("request_path", ["quick_service", "ai_assisted", "managed_project"]);
export const requestStatus = pgEnum("request_status", [
  "draft", "open", "matched", "converted", "cancelled", "closed",
]);
// PRD §95
export const candidateStatus = pgEnum("candidate_status", [
  "invited", "viewed", "interested", "quoted", "negotiating",
  "accepted", "assigned", "declined", "expired",
]);

export const projectStatus = pgEnum("project_status", [
  "draft", "active", "on_hold", "completed", "aftercare", "cancelled", "disputed",
]);
// PRD §77 (calculated deterministically from project data)
export const projectHealth = pgEnum("project_health", [
  "on_track", "attention_required", "delayed", "blocked", "awaiting_customer",
  "awaiting_provider", "awaiting_material", "awaiting_approval", "awaiting_payment", "disputed",
]);
// PRD §114
export const projectRole = pgEnum("project_role", [
  "project_owner", "project_manager", "supervisor", "provider", "provider_team_member",
  "consultant", "inspector", "merchant", "procurement_officer", "finance_approver",
  "observer", "auditor",
]);
export const stageStatus = pgEnum("stage_status", ["pending", "active", "completed", "cancelled"]);

// PRD §134
export const taskStatus = pgEnum("task_status", [
  "draft", "ready", "offered", "assigned", "accepted", "in_progress",
  "submitted", "approved", "completed", "blocked", "cancelled", "disputed",
]);
// PRD §70
export const dependencyType = pgEnum("dependency_type", [
  "finish_to_start", "start_to_start", "external", "material", "approval", "payment",
]);
// PRD §63
export const materialResponsibility = pgEnum("material_responsibility", [
  "customer", "provider", "merchant", "shared", "not_applicable",
]);
export const assignmentStatus = pgEnum("assignment_status", [
  "offered", "accepted", "rejected", "withdrawn", "active", "completed", "cancelled",
]);

export const quoteStatus = pgEnum("quote_status", [
  "draft", "submitted", "revision_requested", "accepted", "rejected", "expired", "withdrawn",
]);
// PRD §52
export const quoteLineKind = pgEnum("quote_line_kind", [
  "labour", "transport", "inspection", "equipment", "materials",
  "subcontractor", "tax", "platform_fee", "optional", "other",
]);

export const milestoneStatus = pgEnum("milestone_status", [
  "pending", "funded", "in_progress", "submitted", "approved", "released", "disputed", "cancelled",
]);
// PRD §66
export const evidenceKind = pgEnum("evidence_kind", [
  "photo_before", "photo_progress", "photo_after", "video", "checklist", "measurement",
  "signature", "inspection", "serial_number", "document", "receipt", "sensor_data",
]);
// PRD §58-60
export const changeStatus = pgEnum("change_status", [
  "draft", "proposed", "under_review", "accepted", "rejected", "withdrawn", "applied",
]);
export const changeFinancialEffect = pgEnum("change_financial_effect", [
  "no_cost", "increase", "reduction", "credit", "partial_cancellation",
]);

// PRD §31
export const conversationContext = pgEnum("conversation_context", [
  "project", "stage", "task", "quote", "change_request", "milestone",
  "dispute", "merchant_order", "private",
]);

// PRD §135
export const paymentState = pgEnum("payment_state", [
  "created", "pending", "authorised", "funded", "secured", "partially_released",
  "released", "failed", "refunded", "partially_refunded", "disputed", "chargeback",
]);
export const payoutState = pgEnum("payout_state", ["pending", "processing", "paid", "failed", "cancelled"]);

// PRD §50 - never one ambiguous balance
export const ledgerAccountKind = pgEnum("ledger_account_kind", [
  "external_clearing", "protected_funds", "provider_earnings", "merchant_earnings",
  "platform_fees", "taxes_payable", "payout_clearing", "refunds",
  "disputed_funds", "promotional_credits", "adjustments",
]);
export const ledgerDirection = pgEnum("ledger_direction", ["debit", "credit"]);
export const ledgerEntryKind = pgEnum("ledger_entry_kind", [
  "payment_captured", "funds_secured", "milestone_released", "fee_applied", "payout",
  "refund", "adjustment", "dispute_hold", "dispute_release", "chargeback", "fx",
]);

export const actorType = pgEnum("actor_type", ["user", "system", "admin", "provider_webhook"]);
export const notificationChannel = pgEnum("notification_channel", [
  "in_app", "push", "email", "sms", "messaging",
]);
export const notificationStatus = pgEnum("notification_status", ["pending", "sent", "failed", "read"]);
