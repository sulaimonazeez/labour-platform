import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { activityEvents, payments, payouts, providerPayoutAccounts, providerProfiles } from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { requirePlatformAdmin } from "../authz/platform-admin.js";
import { beginTransfer, cancelPendingPayout, payoutCols, payoutGateway, runTransfer, verifyPayout } from "../payments/payouts.js";
import { paymentCols, pendingTtlMs } from "../payments/service.js";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http.js";

// Platform staff only (allowlist, see authz/platform-admin.ts). Everyone else gets 404.
//   GET  /admin/attention                 things a human must look at
//   GET  /admin/payouts?state=pending     the payout queue
//   POST /admin/payouts/:id/approve       reserve -> processing -> send (two-phase, see payments/payouts.ts)
//   POST /admin/payouts/:id/reject        pending -> cancelled, earnings returned
//   POST /admin/payouts/:id/verify        resolve a stuck `processing` payout
// Approve/reject/verify are made safe by STATE (a repeat gets 409 payout_not_pending), not by Idempotency-Key,
// because approve talks to the gateway outside a database transaction.

const ATTENTION_EVENTS = [
  "payment.amount_mismatch", "payment.late_success", "gateway.event_received",
  "payout.failed", "payout.reversal_after_paid",
];
const STATES = ["pending", "processing", "paid", "failed", "cancelled"] as const;
const reasonBody = z.strictObject({ reason: z.string().trim().min(1).max(500).optional() });

export const adminRoutes = new Hono<AuthEnv>();
adminRoutes.use("*", requireAuth);
adminRoutes.use("*", async (c, next) => {
  requirePlatformAdmin(c.get("auth").userId);
  await next();
});

adminRoutes.get("/attention", async (c) => {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const events = await db
    .select({ id: activityEvents.id, eventType: activityEvents.eventType, projectId: activityEvents.projectId, subjectType: activityEvents.subjectType, subjectId: activityEvents.subjectId, payload: activityEvents.payload, occurredAt: activityEvents.occurredAt })
    .from(activityEvents)
    .where(and(inArray(activityEvents.eventType, ATTENTION_EVENTS), gte(activityEvents.occurredAt, since)))
    .orderBy(desc(activityEvents.occurredAt))
    .limit(200);
  const stalePayments = await db.select(paymentCols).from(payments)
    .where(and(eq(payments.state, "pending"), lt(payments.createdAt, new Date(Date.now() - pendingTtlMs()))))
    .orderBy(desc(payments.createdAt)).limit(100);
  const openPayouts = await db.select(payoutCols).from(payouts)
    .where(inArray(payouts.state, ["pending", "processing", "failed"])).orderBy(desc(payouts.createdAt)).limit(100);
  return c.json({ since, events, stalePayments, openPayouts });
});

adminRoutes.get("/payouts", async (c) => {
  const state = c.req.query("state");
  if (state !== undefined && !(STATES as readonly string[]).includes(state)) throw new ApiError(400, "validation_error", "Unknown state");
  // An admin must see WHO is being paid and WHERE before approving money out (PRD §125). Never the full account number or the gateway recipient code.
  // The account cannot be changed while a payout is pending or processing, so what is shown is what will be paid.
  const rows = await db
    .select({
      ...payoutCols,
      providerName: providerProfiles.displayName,
      accountName: providerPayoutAccounts.accountName,
      accountLast4: providerPayoutAccounts.accountLast4,
      bankCode: providerPayoutAccounts.bankCode,
    })
    .from(payouts)
    .leftJoin(providerProfiles, eq(providerProfiles.id, payouts.providerProfileId))
    .leftJoin(providerPayoutAccounts, eq(providerPayoutAccounts.providerProfileId, payouts.providerProfileId))
    .where(state ? eq(payouts.state, state as (typeof STATES)[number]) : undefined)
    .orderBy(desc(payouts.createdAt)).limit(200);
  return c.json({ payouts: rows });
});

adminRoutes.post("/payouts/:id/approve", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  parseOrThrow(z.strictObject({}), (await readJson(c)) ?? {});
  const { providerCode, gw } = payoutGateway();
  const actor = { actorType: "admin" as const, userId };

  const begun = await beginTransfer(id, actor, providerCode);          // phase 1: commit `processing`
  const res = await runTransfer(gw, begun.payout, begun.recipientCode, begun.reference, actor); // phases 2-3
  return c.json({ payout: res.payout, outcome: res.outcome });
});

adminRoutes.post("/payouts/:id/reject", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const b = parseOrThrow(reasonBody, (await readJson(c)) ?? {});
  const row = await db.transaction((tx) => cancelPendingPayout(tx, id, { actorType: "admin", userId }, b.reason ?? null));
  return c.json({ payout: row });
});

adminRoutes.post("/payouts/:id/verify", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const res = await verifyPayout(id, { actorType: "admin", userId });
  return c.json({ payout: res.payout, outcome: res.outcome, gatewayStatus: res.gatewayStatus });
});
