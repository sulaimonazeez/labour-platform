import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { assignments, milestones, payments, platformFeeRules, projects, users } from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { isProviderOnly, PROJECT_MANAGERS, requireProjectRole, type ProjectRole } from "../authz/projects.js";
import type { Executor } from "../db/types.js";
import { computeFeeMinor, pickFeeRule } from "../engine/fees.js";
import { assertTransition, MILESTONE_TRANSITIONS, PAYMENT_TRANSITIONS } from "../engine/state-machines.js";
import { recordActivity } from "../lib/activity.js";
import { idempotencyKey, runIdempotent } from "../lib/idempotency.js";
import { getPaymentProvider } from "../payments/index.js";
import { postEntry } from "../payments/ledger.js";
import { ProviderError, type PaymentProvider } from "../payments/provider.js";
import { GATEWAY_ALERT_EVENT, logGatewayEvent } from "../payments/gateway-events.js";
import { handleTransferWebhook } from "../payments/payouts.js";
import { applyVerification, expirePayment, isStale, loadPayment, paymentCols } from "../payments/service.js";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http.js";

// Payments (PRD §47-51, §57; DECISIONS D45-D49).
//   manager/finance approver: POST /milestones/:id/payments   (start a protected payment for a milestone)
//                             POST /milestones/:id/release    (release an APPROVED, funded milestone to the provider's earnings)
//                             GET  /payments/:id, POST /payments/:id/verify
//   gateway:                  POST /webhooks/:provider        (signature-verified; replays are harmless)
// Payment state is separate from milestone state: a milestone is only `funded` once the gateway confirms the money.

const MONEY_ROLES: readonly ProjectRole[] = [...PROJECT_MANAGERS, "finance_approver"];
const emptyBody = z.strictObject({});

/** Provider-only members must not learn money exists (404); other members without a money role get 403. */
async function requireMoneyRole(ex: Executor, projectId: string, userId: string) {
  const roles = await requireProjectRole(ex, projectId, userId);
  if (isProviderOnly(roles)) throw new ApiError(404, "not_found", "Not found");
  if (!roles.some((r) => MONEY_ROLES.includes(r))) throw new ApiError(403, "forbidden", "You do not have permission to do this");
}

async function loadMilestoneForPayment(ex: Executor, id: string) {
  const [m] = await ex
    .select({
      id: milestones.id, projectId: milestones.projectId, assignmentId: milestones.assignmentId,
      amountMinor: milestones.amountMinor, currency: milestones.currency, status: milestones.status,
    })
    .from(milestones)
    .where(eq(milestones.id, id))
    .limit(1)
    .for("update");
  if (!m) throw new ApiError(404, "not_found", "Not found");
  return m;
}

async function requireOpenProject(ex: Executor, projectId: string) {
  const [p] = await ex.select({ status: projects.status, marketId: projects.marketId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) throw new ApiError(404, "not_found", "Not found");
  if (p.status !== "draft" && p.status !== "active") throw new ApiError(409, "project_not_open", `A ${p.status} project cannot take payments`);
  return p;
}

async function callProvider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProviderError) throw new ApiError(502, "payment_provider_error", e.message);
    throw e;
  }
}

// ---------------------------------------------------------------- milestone-scoped
export const milestonePaymentRoutes = new Hono<AuthEnv>();
milestonePaymentRoutes.use("*", requireAuth);

milestonePaymentRoutes.post("/:id/payments", async (c) => {
  const userId = c.get("auth").userId;
  const milestoneId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  parseOrThrow(emptyBody, raw ?? {});
  const provider = getPaymentProvider();

  return runIdempotent(c, { scope: "payments.create", userId, body: raw }, async (tx) => {
    const m = await loadMilestoneForPayment(tx, milestoneId);
    await requireMoneyRole(tx, m.projectId, userId);
    await requireOpenProject(tx, m.projectId);

    if (m.status !== "pending") throw new ApiError(409, "milestone_not_payable", `A ${m.status} milestone cannot be funded`, { status: m.status });
    if (m.amountMinor <= 0) throw new ApiError(409, "milestone_has_no_amount", "This milestone has no amount to fund");

    const live = await tx
      .select({ id: payments.id, state: payments.state, createdAt: payments.createdAt, providerCode: payments.providerCode, providerReference: payments.providerReference })
      .from(payments)
      .where(and(eq(payments.milestoneId, m.id), ne(payments.state, "failed")))
      .for("update");
    for (const l of live) {
      // Abandoned checkout (D53): a pending payment older than the TTL does not block a retry, but we ASK THE GATEWAY first:
      // the customer may have paid and never returned. This is lazy expiry: no background job.
      const stale = l.state === "pending" && isStale(l.createdAt) && l.providerReference !== null && l.providerCode === provider.code;
      if (!stale) throw new ApiError(409, "payment_exists", "This milestone already has a payment", { paymentId: l.id, state: l.state });
      const ref = l.providerReference as string;
      const v = await callProvider(() => provider.verify(ref));
      const out = await applyVerification(tx, l.id, v, { actorType: "user", userId });
      // These two return 200 (not an error) so the transaction COMMITS what applyVerification just recorded.
      if (out.outcome === "secured") return { status: 200, body: { payment: out.payment, alreadyPaid: true } };
      if (out.outcome === "mismatch") return { status: 200, body: { payment: out.payment, needsReview: true, reason: "amount_mismatch" } };
      if (out.payment.state === "pending") await expirePayment(tx, out.payment, { actorType: "user", userId }, "stale_checkout");
    }

    const [payer] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!payer?.email) throw new ApiError(409, "payer_email_required", "The paying user needs an email address on file");

    // A fresh reference per attempt: if this transaction rolls back after the gateway accepted the reference,
    // a retry uses a new one instead of colliding with "duplicate reference".
    const reference = `lp_${randomUUID().replaceAll("-", "")}`;
    const init = await callProvider(() =>
      provider.initialize({
        reference,
        amountMinor: m.amountMinor,
        currency: m.currency,
        email: payer.email as string,
        callbackUrl: process.env.PAYMENTS_CALLBACK_URL?.trim() || undefined,
        metadata: { milestoneId: m.id, projectId: m.projectId },
      }),
    );

    const [row] = await tx
      .insert(payments)
      .values({
        projectId: m.projectId,
        milestoneId: m.id,
        payerUserId: userId,
        amountMinor: m.amountMinor,
        currency: m.currency,
        state: "pending",
        providerCode: provider.code,
        providerReference: init.providerReference,
        idempotencyKey: `payments.create:${userId}:${idempotencyKey(c)}`,
      })
      .returning(paymentCols);

    await recordActivity(tx, {
      projectId: m.projectId, actorUserId: userId, eventType: "payment.initiated", subjectType: "payment", subjectId: row.id,
      payload: { milestoneId: m.id, amountMinor: m.amountMinor, currency: m.currency, providerCode: provider.code },
    });
    return { status: 201, body: { payment: row, checkoutUrl: init.checkoutUrl } };
  });
});

milestonePaymentRoutes.post("/:id/release", async (c) => {
  const userId = c.get("auth").userId;
  const milestoneId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  parseOrThrow(emptyBody, raw ?? {});

  return runIdempotent(c, { scope: "milestones.release", userId, body: raw }, async (tx) => {
    const m = await loadMilestoneForPayment(tx, milestoneId);
    await requireMoneyRole(tx, m.projectId, userId);
    const project = await requireOpenProject(tx, m.projectId);

    if (m.status !== "approved") throw new ApiError(409, "milestone_not_approved", `Only an approved milestone can be released (this one is ${m.status})`, { status: m.status });
    if (!m.assignmentId) throw new ApiError(409, "no_assignment", "This milestone has no assigned provider to pay");
    if (m.amountMinor <= 0) throw new ApiError(409, "milestone_has_no_amount", "This milestone has no amount to release");

    const [p] = await tx
      .select(paymentCols)
      .from(payments)
      .where(and(eq(payments.milestoneId, m.id), inArray(payments.state, ["secured", "partially_released"])))
      .limit(1)
      .for("update");
    if (!p) throw new ApiError(409, "no_secured_payment", "There is no secured payment for this milestone");
    const held = p.amountMinor - p.releasedMinor - p.refundedMinor;
    if (held < m.amountMinor || p.currency !== m.currency) {
      throw new ApiError(409, "insufficient_secured_funds", "The secured payment does not cover this milestone", { held, needed: m.amountMinor });
    }

    const [a] = await tx.select({ providerProfileId: assignments.providerProfileId }).from(assignments).where(eq(assignments.id, m.assignmentId)).limit(1);
    if (!a) throw new ApiError(409, "no_assignment", "This milestone has no assigned provider to pay");

    const rules = await tx
      .select({
        marketId: platformFeeRules.marketId, categoryId: platformFeeRules.categoryId, basisPoints: platformFeeRules.basisPoints,
        minFeeMinor: platformFeeRules.minFeeMinor, maxFeeMinor: platformFeeRules.maxFeeMinor, currency: platformFeeRules.currency,
        effectiveFrom: platformFeeRules.effectiveFrom, effectiveTo: platformFeeRules.effectiveTo,
      })
      .from(platformFeeRules)
      .where(eq(platformFeeRules.isActive, true));
    const rule = pickFeeRule(rules, { marketId: project.marketId, currency: m.currency, today: new Date().toISOString().slice(0, 10) });
    const feeMinor = computeFeeMinor(m.amountMinor, rule, m.currency);
    const earningsMinor = m.amountMinor - feeMinor;

    const lines: Parameters<typeof postEntry>[1]["lines"] = [
      { account: "protected_funds", ownerKey: `project:${m.projectId}`, direction: "debit", amountMinor: m.amountMinor, currency: m.currency },
    ];
    if (earningsMinor > 0) lines.push({ account: "provider_earnings", ownerKey: `provider:${a.providerProfileId}`, direction: "credit", amountMinor: earningsMinor, currency: m.currency });
    if (feeMinor > 0) lines.push({ account: "platform_fees", ownerKey: "platform", direction: "credit", amountMinor: feeMinor, currency: m.currency });

    await postEntry(tx, {
      kind: "milestone_released",
      projectId: m.projectId,
      milestoneId: m.id,
      paymentId: p.id,
      description: "Milestone released to provider earnings",
      idempotencyKey: `milestone:${m.id}:release`,
      lines,
    });

    const released = p.releasedMinor + m.amountMinor;
    const nextState = released + p.refundedMinor >= p.amountMinor ? "released" : "partially_released";
    assertTransition(PAYMENT_TRANSITIONS, p.state, nextState);
    const [payment] = await tx.update(payments).set({ state: nextState, releasedMinor: released }).where(eq(payments.id, p.id)).returning(paymentCols);

    assertTransition(MILESTONE_TRANSITIONS, "approved", "released");
    const [milestone] = await tx.update(milestones).set({ status: "released" }).where(eq(milestones.id, m.id)).returning({ id: milestones.id, status: milestones.status });

    await recordActivity(tx, {
      projectId: m.projectId, actorUserId: userId, eventType: "milestone.released", subjectType: "milestone", subjectId: m.id,
      payload: { paymentId: p.id, amountMinor: m.amountMinor, feeMinor, earningsMinor, currency: m.currency },
    });
    return { status: 200, body: { milestone, payment, release: { amountMinor: m.amountMinor, feeMinor, earningsMinor, currency: m.currency } } };
  });
});

// ---------------------------------------------------------------- payment-scoped
export const paymentRoutes = new Hono<AuthEnv>();
paymentRoutes.use("*", requireAuth);

paymentRoutes.get("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const p = await loadPayment(db, uuidParam(c.req.param("id")), false);
  await requireMoneyRole(db, p.projectId, userId);
  return c.json({ payment: p });
});

// Customer returns from the gateway (or the app polls): ask the gateway, then apply. Safe to repeat.
paymentRoutes.post("/:id/verify", async (c) => {
  const userId = c.get("auth").userId;
  const p = await loadPayment(db, uuidParam(c.req.param("id")), false);
  await requireMoneyRole(db, p.projectId, userId);
  // `failed` is included on purpose: a payment closed as expired may still turn out to have been paid (late_success).
  if ((p.state !== "pending" && p.state !== "failed") || !p.providerReference) return c.json({ payment: p, outcome: "unchanged", providerStatus: null });

  const provider = getPaymentProvider();
  if (p.providerCode !== provider.code) throw new ApiError(409, "provider_mismatch", "This payment belongs to a different payment provider");
  const ref = p.providerReference;
  const v = await callProvider(() => provider.verify(ref));
  const out = await db.transaction((tx) => applyVerification(tx, p.id, v, { actorType: "user", userId }));
  return c.json({ payment: out.payment, outcome: out.outcome, providerStatus: v.found ? v.status : "not_found" });
});

// ---------------------------------------------------------------- gateway webhooks
export const webhookRoutes = new Hono();

webhookRoutes.post("/:provider", async (c) => {
  const provider: PaymentProvider = getPaymentProvider();
  if (c.req.param("provider") !== provider.code) throw new ApiError(404, "not_found", "Not found");

  const raw = await c.req.text(); // the signature covers the RAW bytes: never re-serialise
  if (!provider.verifyWebhookSignature(raw, c.req.header("x-paystack-signature"))) {
    throw new ApiError(401, "invalid_signature", "Invalid signature");
  }

  // 200 for everything we deliberately ignore, so the gateway stops retrying. Only a processing failure (5xx) is retried.
  const event = provider.parseWebhook(raw);
  if (!event) return c.json({ received: true, handled: false });

  // Money out: transfer.success | transfer.failed | transfer.reversed (confirmed with the gateway, never trusted).
  if (event.type.startsWith("transfer.") && event.reference) {
    const r = await handleTransferWebhook(provider.code, event.reference);
    return c.json({ received: true, handled: r.handled, outcome: r.outcome });
  }
  // Refunds, disputes, chargebacks: logged for a human (GET /admin/attention), never applied automatically (D54).
  if (GATEWAY_ALERT_EVENT.test(event.type)) {
    const r = await logGatewayEvent(provider.code, raw, event);
    return c.json({ received: true, handled: r.handled });
  }
  if (event.type !== "charge.success" || !event.reference) return c.json({ received: true, handled: false });

  const [p] = await db
    .select(paymentCols)
    .from(payments)
    .where(and(eq(payments.providerCode, provider.code), eq(payments.providerReference, event.reference)))
    .limit(1);
  // `failed` is allowed: a closed (expired) checkout that gets paid anyway becomes a late_success.
  if (!p || (p.state !== "pending" && p.state !== "failed")) return c.json({ received: true, handled: false });

  // Never trust the webhook body for money: confirm with the gateway before changing anything.
  const ref = event.reference;
  const v = await callProvider(() => provider.verify(ref));
  const out = await db.transaction((tx) => applyVerification(tx, p.id, v, { actorType: "provider_webhook", userId: null }));
  return c.json({ received: true, handled: out.changed, outcome: out.outcome });
});
