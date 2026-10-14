import { and, eq } from "drizzle-orm";
import { ApiError } from "../api/http";
import { milestones, payments } from "../db/schema";
import type { Executor } from "../db/types";
import { assertTransition, MILESTONE_TRANSITIONS, PAYMENT_TRANSITIONS } from "../engine/state-machines";
import { recordActivity, type ActivityActorType } from "../lib/activity";
import { postEntry } from "./ledger";
import type { VerifyResult } from "./provider";

export const paymentCols = {
  id: payments.id,
  projectId: payments.projectId,
  milestoneId: payments.milestoneId,
  payerUserId: payments.payerUserId,
  amountMinor: payments.amountMinor,
  currency: payments.currency,
  state: payments.state,
  providerCode: payments.providerCode,
  methodCode: payments.methodCode,
  providerReference: payments.providerReference,
  releasedMinor: payments.releasedMinor,
  refundedMinor: payments.refundedMinor,
  createdAt: payments.createdAt,
  updatedAt: payments.updatedAt,
};

export async function loadPayment(ex: Executor, id: string, lock: boolean) {
  const q = ex.select(paymentCols).from(payments).where(eq(payments.id, id)).limit(1);
  const [p] = lock ? await q.for("update") : await q;
  if (!p) throw new ApiError(404, "not_found", "Not found");
  return p;
}

export type Actor = { actorType: ActivityActorType; userId: string | null };
export type ApplyOutcome = "secured" | "failed" | "unchanged" | "mismatch" | "late_success";

/**
 * Abandoned checkout (DECISIONS D53). A payment still `pending` after this long is "stale": the customer may have
 * walked away, or paid and never returned. Expiry is LAZY (checked when someone tries to pay again), never a background job.
 */
export function pendingTtlMs(): number {
  const m = Number(process.env.PAYMENT_PENDING_TTL_MINUTES ?? 30);
  return (Number.isFinite(m) && m >= 0 ? m : 30) * 60_000;
}
export const isStale = (createdAt: Date, now: number = Date.now()) => now - createdAt.getTime() >= pendingTtlMs();

type PaymentRow = Awaited<ReturnType<typeof loadPayment>>;

/** Closes a stale pending payment (pending -> failed). Money that still arrives later is caught by applyVerification (late_success). */
export async function expirePayment(tx: Executor, p: PaymentRow, actor: Actor, reason: string): Promise<PaymentRow> {
  assertTransition(PAYMENT_TRANSITIONS, "pending", "failed");
  const [row] = await tx.update(payments).set({ state: "failed" }).where(and(eq(payments.id, p.id), eq(payments.state, "pending"))).returning(paymentCols);
  if (!row) return p;
  await recordActivity(tx, {
    projectId: p.projectId, actorType: actor.actorType, actorUserId: actor.userId, subjectType: "payment", subjectId: p.id,
    eventType: "payment.expired",
    payload: { milestoneId: p.milestoneId, reason, ageMinutes: Math.round((Date.now() - p.createdAt.getTime()) / 60_000) },
  });
  return row;
}

/**
 * Applies what the gateway says about a PENDING payment. Called by both the customer-triggered verify endpoint
 * and the webhook, so it must be safe to run twice or concurrently:
 *  - the payment row is locked FOR UPDATE, so the second caller waits, then sees a non-pending state and does nothing;
 *  - the ledger entry has a fixed idempotency key, so even a bug here could not double-post.
 * "secured" here means: verified by the gateway AND ring-fenced in our ledger (protected_funds). It is NOT a claim
 * of a regulated escrow account (PRD §49): that is a legal/licensing question per market, to settle before launch.
 */
export async function applyVerification(
  tx: Executor,
  paymentId: string,
  v: VerifyResult,
  actor: Actor,
): Promise<{ changed: boolean; outcome: ApplyOutcome; payment: Awaited<ReturnType<typeof loadPayment>> }> {
  const p = await loadPayment(tx, paymentId, true);
  const unchanged = { changed: false, outcome: "unchanged" as const, payment: p };
  const who = { projectId: p.projectId, actorType: actor.actorType, actorUserId: actor.userId, subjectType: "payment", subjectId: p.id };

  // Money arriving for a payment we had already closed (expired checkout). Never lose it silently: record it in the
  // ledger as SUSPENSE (not protected funds, not released) and raise a loud event for a human to refund or reassign.
  if (p.state === "failed") {
    if (!v.found || v.status !== "success" || !Number.isSafeInteger(v.amountMinor) || v.amountMinor <= 0) return unchanged;
    const posted = await postEntry(tx, {
      kind: "adjustment",
      projectId: p.projectId,
      milestoneId: p.milestoneId,
      paymentId: p.id,
      description: `Late payment on an expired checkout (${p.providerCode}); held in suspense for review`,
      idempotencyKey: `payment:${p.id}:late_success`,
      lines: [
        { account: "external_clearing", ownerKey: `provider:${p.providerCode}`, direction: "debit", amountMinor: v.amountMinor, currency: v.currency },
        { account: "adjustments", ownerKey: `suspense:payment:${p.id}`, direction: "credit", amountMinor: v.amountMinor, currency: v.currency },
      ],
    });
    if (!posted.posted) return unchanged;
    await recordActivity(tx, {
      ...who, eventType: "payment.late_success",
      payload: { milestoneId: p.milestoneId, amountMinor: v.amountMinor, currency: v.currency, expected: { amountMinor: p.amountMinor, currency: p.currency }, providerCode: p.providerCode },
    });
    return { changed: true, outcome: "late_success", payment: p };
  }

  if (p.state !== "pending" || !v.found || v.status === "pending") return unchanged;

  if (v.status === "failed") {
    assertTransition(PAYMENT_TRANSITIONS, "pending", "failed");
    const [row] = await tx.update(payments).set({ state: "failed" }).where(eq(payments.id, p.id)).returning(paymentCols);
    await recordActivity(tx, { ...who, eventType: "payment.failed", payload: { milestoneId: p.milestoneId, providerCode: p.providerCode } });
    return { changed: true, outcome: "failed", payment: row };
  }

  if (v.amountMinor !== p.amountMinor || v.currency !== p.currency) {
    await recordActivity(tx, {
      ...who, eventType: "payment.amount_mismatch",
      payload: { expected: { amountMinor: p.amountMinor, currency: p.currency }, reported: { amountMinor: v.amountMinor, currency: v.currency } },
    });
    return { changed: false, outcome: "mismatch", payment: p };
  }

  assertTransition(PAYMENT_TRANSITIONS, "pending", "funded");
  assertTransition(PAYMENT_TRANSITIONS, "funded", "secured");
  const [row] = await tx.update(payments).set({ state: "secured", methodCode: v.channel }).where(eq(payments.id, p.id)).returning(paymentCols);

  await postEntry(tx, {
    kind: "payment_captured",
    projectId: p.projectId,
    milestoneId: p.milestoneId,
    paymentId: p.id,
    description: `Payment captured via ${p.providerCode}`,
    idempotencyKey: `payment:${p.id}:captured`,
    lines: [
      { account: "external_clearing", ownerKey: `provider:${p.providerCode}`, direction: "debit", amountMinor: p.amountMinor, currency: p.currency },
      { account: "protected_funds", ownerKey: `project:${p.projectId}`, direction: "credit", amountMinor: p.amountMinor, currency: p.currency },
    ],
  });

  if (p.milestoneId) {
    const [m] = await tx.select({ status: milestones.status }).from(milestones).where(eq(milestones.id, p.milestoneId)).limit(1).for("update");
    // Work may already have started on an unfunded milestone; only a pending one flips to funded.
    if (m && m.status === "pending") {
      assertTransition(MILESTONE_TRANSITIONS, "pending", "funded");
      await tx.update(milestones).set({ status: "funded" }).where(eq(milestones.id, p.milestoneId));
    }
  }

  await recordActivity(tx, {
    ...who, eventType: "payment.secured",
    payload: { milestoneId: p.milestoneId, amountMinor: p.amountMinor, currency: p.currency, providerCode: p.providerCode, channel: v.channel },
  });
  return { changed: true, outcome: "secured", payment: row };
}
