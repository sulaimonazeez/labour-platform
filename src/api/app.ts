import { intakeRoutes } from "./intake-routes.js";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "../db/client.js";
import { users } from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { adminRoutes } from "./admin-routes.js";
import { assignmentRoutes } from "./assignment-routes.js";
import { authRoutes } from "./auth-routes.js";
import { projectListRoutes, providerDirectoryRoutes, referenceRoutes } from "./discovery-routes.js";
import { milestoneEvidenceRoutes, taskEvidenceRoutes } from "./evidence-routes.js";
import { milestoneRoutes, projectMilestoneRoutes } from "./milestone-routes.js";
import { milestonePaymentRoutes, paymentRoutes, webhookRoutes } from "./payment-routes.js";
import { projectMoneyViewRoutes } from "./money-view-routes.js";
import { providerPayoutRoutes } from "./payout-routes.js";
import { projectRoutes } from "./project-routes.js";
import { providerRoutes } from "./provider-routes.js";
import { quoteRoutes, taskQuoteRoutes } from "./quote-routes.js";
import { requestRoutes } from "./request-routes.js";
import { taskRoutes } from "./task-routes.js";
import { threadRoutes } from "./thread-routes.js";
import { activityRoutes } from "./activity-routes.js";
import { taskEvidenceUploadRoutes } from "./evidence-upload-routes.js";
import { changeProjectRoutes, changeRoutes } from "./change-routes.js";
import { notificationRoutes } from "./notification-routes.js";
import { providerReviewRoutes, reviewProjectRoutes } from "./review-routes.js";
import { taskWorkRoutes } from "./task-work-routes.js";
import { asApiError, err } from "./http.js";
import { aiRoutes, changeAiRoutes, draftRoutes, projectAiRoutes, requestDraftRoutes, taskAiRoutes } from "./ai-routes.js";
import { categoryRoutes, discoverRoutes, flagRoutes, languageRoutes, templateRoutes } from "./catalog-routes.js";
import { assetRoutes, merchantRoutes, orderRoutes, procurementProjectRoutes, procurementRoutes, productRoutes, projectAfterRoutes, warrantyRoutes } from "./commerce-routes.js";
import { conversationRoutes } from "./conversation-routes.js";
import { disputeRoutes, projectDisputeRoutes } from "./dispute-routes.js";
import { approvalRoutes, orgRoutes } from "./org-routes.js";
import { issueRoutes, opsRoutes, safetyRoutes } from "./ops-routes.js";
import { insightRoutes, jobRoutes, platformAdminRoutes, programmeRoutes } from "./platform-routes.js";
import { availabilityRoutes, bookingRoutes, bookingTaskRoutes, checkInRoutes, policyRoutes, recurringRoutes } from "./schedule-routes.js";
import { accountRoutes, customerSignalRoutes, insuranceAdminRoutes, insuranceRoutes, moderationRoutes, subcontractAssignmentRoutes, subcontractRoutes, teamRoutes, trustRoutes, verificationRoutes } from "./trust-routes.js";

export const app = new Hono<AuthEnv>();

// CORS is opt-in: set CORS_ORIGINS to a comma-separated list of allowed web origins.
// Unset = no CORS headers (same-origin and server-to-server only).
const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
if (corsOrigins.length > 0) {
  app.use(
    "*",
    cors({
      origin: corsOrigins,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
      exposeHeaders: ["Idempotent-Replayed", "Retry-After"],
      maxAge: 600,
    }),
  );
}

app.get("/health", (c) => c.json({ ok: true }));

app.route("/auth", authRoutes);
app.route("/requests", requestRoutes);
app.route("/requests", intakeRoutes);
app.route("/projects", projectRoutes);
app.route("/tasks", taskRoutes);
app.route("/tasks", taskQuoteRoutes);
app.route("/tasks", threadRoutes);
app.route("/tasks", taskEvidenceUploadRoutes);
app.route("/projects", changeProjectRoutes);
app.route("/projects", activityRoutes);
app.route("/projects", reviewProjectRoutes);
app.route("/changes", changeRoutes);
app.route("/notifications", notificationRoutes);
app.route("/providers", providerReviewRoutes);
app.route("/providers", providerRoutes);
app.route("/providers", providerPayoutRoutes);
app.route("/quotes", quoteRoutes);
app.route("/assignments", assignmentRoutes);
app.route("/projects", projectMilestoneRoutes);
app.route("/milestones", milestoneRoutes);
app.route("/milestones", milestoneEvidenceRoutes);
app.route("/tasks", taskEvidenceRoutes);
app.route("/tasks", taskWorkRoutes);
app.route("/milestones", milestonePaymentRoutes);
app.route("/payments", paymentRoutes);
app.route("/webhooks", webhookRoutes);
app.route("/admin", adminRoutes);
app.route("/reference", referenceRoutes);
app.route("/projects", projectListRoutes);
app.route("/projects", projectMoneyViewRoutes);
app.route("/providers", providerDirectoryRoutes);

app.get("/me", requireAuth, async (c) => {
  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      phone: users.phone,
      displayName: users.displayName,
      preferredLanguage: users.preferredLanguage,
      secondaryLanguages: users.secondaryLanguages,
      autoTranslate: users.autoTranslate,
      showOriginalByDefault: users.showOriginalByDefault,
      timezone: users.timezone,
      marketId: users.marketId,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, c.get("auth").userId))
    .limit(1);
  if (!u) return c.json(err("unauthorized", "Missing or invalid credentials"), 401);
  return c.json({ user: u });
});

// ── Blueprint layer: the rest of the PRD. Every module degrades gracefully when AI/translation/speech adapters are off. ──
app.route("/categories", categoryRoutes);
app.route("/discover", discoverRoutes);
app.route("/templates", templateRoutes);
app.route("/flags", flagRoutes);
app.route("/languages", languageRoutes);
app.route("/ai", aiRoutes);
app.route("/requests", requestDraftRoutes);
app.route("/drafts", draftRoutes);
app.route("/projects", projectAiRoutes);
app.route("/tasks", taskAiRoutes);
app.route("/changes", changeAiRoutes);
app.route("/conversations", conversationRoutes);
app.route("/providers", availabilityRoutes);
app.route("/tasks", bookingTaskRoutes);
app.route("/bookings", bookingRoutes);
app.route("/tasks", checkInRoutes);
app.route("/cancellation-policies", policyRoutes);
app.route("/recurring", recurringRoutes);
app.route("/projects", opsRoutes);
app.route("/issues", issueRoutes);
app.route("/safety-incidents", safetyRoutes);
app.route("/projects", projectDisputeRoutes);
app.route("/disputes", disputeRoutes);
app.route("/verifications", verificationRoutes);
app.route("/providers", insuranceRoutes);
app.route("/insurance", insuranceAdminRoutes);
app.route("/providers", trustRoutes);
app.route("/projects", customerSignalRoutes);
app.route("/assignments", subcontractAssignmentRoutes);
app.route("/subcontracts", subcontractRoutes);
app.route("/teams", teamRoutes);
app.route("/me", accountRoutes);
app.route("/moderation", moderationRoutes);
app.route("/orgs", orgRoutes);
app.route("/approvals", approvalRoutes);
app.route("/merchants", merchantRoutes);
app.route("/products", productRoutes);
app.route("/orders", orderRoutes);
app.route("/projects", procurementProjectRoutes);
app.route("/procurement", procurementRoutes);
app.route("/assets", assetRoutes);
app.route("/projects", projectAfterRoutes);
app.route("/warranties", warrantyRoutes);
app.route("/programmes", programmeRoutes);
app.route("/insights", insightRoutes);
app.route("/admin", platformAdminRoutes);
app.route("/jobs", jobRoutes);

app.notFound((c) => c.json(err("not_found", "Not found"), 404));

app.onError((e, c) => {
  const api = asApiError(e);
  if (api) return c.json(err(api.code, api.message, api.details), api.status);
  console.error(e);
  return c.json(err("internal", "Internal error"), 500);
});
