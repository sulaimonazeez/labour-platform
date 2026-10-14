import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { assignments, disputeEntries, disputes, merchantOrders, milestones, providerProfiles, quotes, tasks } from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { isPlatformAdmin, requirePlatformAdmin } from "../authz/platform-admin.js";
import { getProjectRoles, PROJECT_MANAGERS, requireProjectRole } from "../authz/projects.js";
import { disputeSummary } from "../ai/context.js";
import { recordActivity } from "../lib/activity.js";
import { runIdempotent } from "../lib/idempotency.js";
import { managerUserIds, notify } from "../lib/notify.js";
import type { Executor } from "../db/types.js";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http.js";

// PRD §101-104. A dispute is scoped to ONE obligation. Only that milestone is frozen; unrelated tasks, providers,
// merchant orders and the rest of the project's funds are never touched (PRD §103). People decide outcomes; the AI summary
// only organises facts and claims (PRD §102, §104).

const FREEZABLE = ["funded", "in_progress", "submitted", "approved"];
const notFound = () => new ApiError(404, "not_found", "Not found");

async function counterpart(ex: Executor, openerId: string, scopeType: string, scopeId: string | null, projectId: string, isManager: boolean): Promise<string | null> {
  const providerUser = async (assignmentId: string | null) => {
    if (!assignmentId) return null;
    const [r] = await ex.select({ uid: providerProfiles.userId }).from(assignments).innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId)).where(eq(assignments.id, assignmentId)).limit(1);
    return r?.uid ?? null;
  };
  if (!isManager) {
    const mgrs = await managerUserIds(ex, projectId);
    return mgrs.find((u) => u !== openerId) ?? mgrs[0] ?? null;
  }
  if (scopeType === "milestone" && scopeId) {
    const [m] = await ex.select({ a: milestones.assignmentId }).from(milestones).where(eq(milestones.id, scopeId)).limit(1);
    return providerUser(m?.a ?? null);
  }
  if (scopeType === "task" && scopeId) {
    const [a] = await ex.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.taskId, scopeId), inArray(assignments.status, ["accepted", "active", "completed"]))).limit(1);
    return providerUser(a?.id ?? null);
  }
  if (scopeType === "quote" && scopeId) {
    const [q] = await ex.select({ uid: providerProfiles.userId }).from(quotes).innerJoin(providerProfiles, eq(providerProfiles.id, quotes.providerProfileId)).where(eq(quotes.id, scopeId)).limit(1);
    return q?.uid ?? null;
  }
  return null;
}

async function loadDispute(ex: Executor, id: string, userId: string, lock = false) {
  const q = ex.select().from(disputes).where(eq(disputes.id, id)).limit(1);
  const [d] = lock ? await q.for("update") : await q;
  if (!d) throw notFound();
  const roles = await getProjectRoles(ex, d.projectId, userId);
  const isManager = roles.some((r) => (PROJECT_MANAGERS as readonly string[]).includes(r));
  const isParty = d.openedByUserId === userId || d.againstUserId === userId;
  const isAdmin = isPlatformAdmin(userId);
  if (!isManager && !isParty && !isAdmin) throw notFound();
  return { d, isManager, isParty, isAdmin };
}

async function releaseScope(ex: Executor, d: typeof disputes.$inferSelect, kind: string) {
  if (d.scopeType !== "milestone" || !d.scopeId) return;
  const [m] = await ex.select({ status: milestones.status }).from(milestones).where(eq(milestones.id, d.scopeId)).limit(1);
  if (!m || m.status !== "disputed") return;
  // refund -> cancelled and release -> approved are the only outcomes that change meaning; everything else restores.
  // The money itself moves through the existing payment routes, never from here.
  const restore = d.priorScopeStatus === "funded" ? "in_progress" : d.priorScopeStatus ?? "in_progress";
  const next = kind === "refund" ? "cancelled" : kind === "release" ? "approved" : restore;
  await ex.update(milestones).set({ status: next as typeof m.status }).where(eq(milestones.id, d.scopeId));
}

export const projectDisputeRoutes = new Hono<AuthEnv>();
projectDisputeRoutes.use("*", requireAuth);

const openBody = z.strictObject({
  scopeType: z.enum(["task", "milestone", "quote", "payment", "merchant_order", "other"]),
  scopeId: z.uuid().optional(),
  reason: z.enum(["not_completed", "poor_quality", "not_as_described", "no_show", "price_dispute", "scope_disagreement", "payment_issue", "safety", "other"]),
  description: z.string().trim().max(4000).optional(),
  amountMinor: z.int().min(0).optional(),
  currency: z.string().trim().length(3).optional(),
});

projectDisputeRoutes.post("/:id/disputes", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(openBody, raw);
  return runIdempotent(c, { scope: "disputes.open", userId, body: { projectId, raw } }, async (tx) => {
    const roles = await requireProjectRole(tx, projectId, userId);
    const isManager = roles.some((r) => (PROJECT_MANAGERS as readonly string[]).includes(r));
    if (b.scopeType !== "other" && b.scopeType !== "payment" && !b.scopeId) throw new ApiError(400, "scope_required", "Say which task, milestone, quote or order this is about");
    let prior: string | null = null;
    let amount = b.amountMinor ?? null;
    let currency = b.currency ?? null;
    if (b.scopeType === "milestone" && b.scopeId) {
      const [m] = await tx.select().from(milestones).where(and(eq(milestones.id, b.scopeId), eq(milestones.projectId, projectId))).limit(1).for("update");
      if (!m) throw notFound();
      if (!isManager) {
        const [a] = m.assignmentId ? await tx.select({ uid: providerProfiles.userId }).from(assignments).innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId)).where(eq(assignments.id, m.assignmentId)).limit(1) : [];
        if (a?.uid !== userId) throw new ApiError(403, "forbidden", "You can only dispute your own milestones");
      }
      amount ??= m.amountMinor;
      currency ??= m.currency;
      const open = await tx.select({ id: disputes.id }).from(disputes).where(and(eq(disputes.scopeType, "milestone"), eq(disputes.scopeId, m.id), inArray(disputes.status, ["open", "awaiting_response", "in_review"]))).limit(1);
      if (open.length > 0) throw new ApiError(409, "dispute_exists", "This milestone already has an open dispute");
      if (FREEZABLE.includes(m.status)) {
        prior = m.status;
        await tx.update(milestones).set({ status: "disputed" }).where(eq(milestones.id, m.id)); // freezes only this amount
      }
    } else if (b.scopeType === "task" && b.scopeId) {
      const [t] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, b.scopeId), eq(tasks.projectId, projectId))).limit(1);
      if (!t) throw notFound();
    } else if (b.scopeType === "quote" && b.scopeId) {
      const [q] = await tx.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, b.scopeId), eq(quotes.projectId, projectId))).limit(1);
      if (!q) throw notFound();
    } else if (b.scopeType === "merchant_order" && b.scopeId) {
      const [o] = await tx.select({ id: merchantOrders.id }).from(merchantOrders).where(and(eq(merchantOrders.id, b.scopeId), eq(merchantOrders.projectId, projectId))).limit(1);
      if (!o) throw notFound();
      await tx.update(merchantOrders).set({ status: "disputed" }).where(eq(merchantOrders.id, b.scopeId)); // order state only: service money is untouched (PRD §51)
    }
    if ((amount !== null) !== (currency !== null)) throw new ApiError(400, "currency_required", "An amount needs a currency and a currency needs an amount");
    const against = await counterpart(tx, userId, b.scopeType, b.scopeId ?? null, projectId, isManager);
    const [row] = await tx.insert(disputes).values({
      projectId, scopeType: b.scopeType, scopeId: b.scopeId ?? null, openedByUserId: userId, againstUserId: against, reason: b.reason, description: b.description ?? null,
      amountMinor: amount, currency, status: "awaiting_response", priorScopeStatus: prior,
    }).returning({ id: disputes.id });
    if (b.description) await tx.insert(disputeEntries).values({ disputeId: row.id, authorUserId: userId, kind: "claim", body: b.description });
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: "dispute.opened", subjectType: b.scopeType === "other" ? "dispute" : b.scopeType, subjectId: b.scopeId ?? row.id, payload: { disputeId: row.id, reason: b.reason, frozen: prior !== null } });
    await notify(tx, [...(against ? [against] : []), ...(await managerUserIds(tx, projectId))], "dispute.opened", { projectId, disputeId: row.id }, userId);
    return { status: 201, body: { dispute: { id: row.id, status: "awaiting_response", frozenMilestone: prior !== null, scope: { type: b.scopeType, id: b.scopeId ?? null } } } };
  });
});

projectDisputeRoutes.get("/:id/disputes", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const roles = await requireProjectRole(db, projectId, userId);
  const rows = await db.select().from(disputes).where(eq(disputes.projectId, projectId)).orderBy(desc(disputes.createdAt));
  const isManager = roles.some((r) => (PROJECT_MANAGERS as readonly string[]).includes(r));
  return c.json({ disputes: rows.filter((d) => isManager || d.openedByUserId === userId || d.againstUserId === userId) });
});

export const disputeRoutes = new Hono<AuthEnv>();
disputeRoutes.use("*", requireAuth);

disputeRoutes.get("/", async (c) => {
  requirePlatformAdmin(c.get("auth").userId);
  const status = c.req.query("status");
  const rows = await db.select().from(disputes).where(status ? eq(disputes.status, status) : sql`true`).orderBy(desc(disputes.createdAt)).limit(200);
  return c.json({ disputes: rows });
});

disputeRoutes.get("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const { d } = await loadDispute(db, uuidParam(c.req.param("id")), userId);
  const entries = await db.select().from(disputeEntries).where(eq(disputeEntries.disputeId, d.id)).orderBy(asc(disputeEntries.createdAt));
  return c.json({ dispute: d, entries });
});

disputeRoutes.get("/:id/summary", async (c) => {
  const userId = c.get("auth").userId;
  const { d } = await loadDispute(db, uuidParam(c.req.param("id")), userId);
  return c.json({ summary: await disputeSummary(db, d.id, userId) });
});

const entryBody = z.strictObject({ kind: z.enum(["claim", "response", "note", "proposal"]), body: z.string().trim().min(1).max(4000) });
disputeRoutes.post("/:id/entries", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(entryBody, raw);
  return runIdempotent(c, { scope: "disputes.entry", userId, body: { id, raw } }, async (tx) => {
    const { d, isParty, isAdmin } = await loadDispute(tx, id, userId, true);
    if (["resolved", "closed"].includes(d.status)) throw new ApiError(409, "dispute_closed", "This dispute is already decided");
    if (b.kind === "note" ? !(isParty || isAdmin) : !isParty) throw new ApiError(403, "forbidden", "Only the people in this dispute can add to it");
    const [row] = await tx.insert(disputeEntries).values({ disputeId: id, authorUserId: userId, kind: b.kind, body: b.body }).returning({ id: disputeEntries.id });
    if (b.kind === "response" && userId !== d.openedByUserId && d.status === "awaiting_response") await tx.update(disputes).set({ status: "in_review" }).where(eq(disputes.id, id));
    await recordActivity(tx, { projectId: d.projectId, actorUserId: userId, eventType: "dispute.entry_added", subjectType: "dispute", subjectId: id, payload: { kind: b.kind } });
    await notify(tx, [d.openedByUserId, d.againstUserId].filter((x): x is string => !!x), "dispute.entry_added", { projectId: d.projectId, disputeId: id }, userId);
    return { status: 201, body: { entry: { id: row.id } } };
  });
});

const acceptBody = z.strictObject({ entryId: z.uuid() });
disputeRoutes.post("/:id/accept-proposal", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(acceptBody, raw);
  return runIdempotent(c, { scope: "disputes.accept", userId, body: { id, raw } }, async (tx) => {
    const { d, isParty } = await loadDispute(tx, id, userId, true);
    if (!isParty) throw new ApiError(403, "forbidden", "Only the people in this dispute can accept a proposal");
    if (["resolved", "closed"].includes(d.status)) throw new ApiError(409, "dispute_closed", "This dispute is already decided");
    const [e] = await tx.select().from(disputeEntries).where(and(eq(disputeEntries.id, b.entryId), eq(disputeEntries.disputeId, id), eq(disputeEntries.kind, "proposal"))).limit(1);
    if (!e) throw notFound();
    if (e.authorUserId === userId) throw new ApiError(409, "own_proposal", "The other party accepts a proposal");
    await tx.update(disputes).set({ status: "resolved", resolutionKind: "other", resolution: e.body, resolvedByUserId: userId, resolvedAt: new Date() }).where(eq(disputes.id, id));
    await releaseScope(tx, d, "other");
    await tx.insert(disputeEntries).values({ disputeId: id, authorUserId: userId, kind: "decision", body: `Accepted proposal: ${e.body}` });
    await recordActivity(tx, { projectId: d.projectId, actorUserId: userId, eventType: "dispute.resolved", subjectType: "dispute", subjectId: id, payload: { by: "agreement" } });
    return { status: 200, body: { dispute: { id, status: "resolved" } } };
  });
});

const resolveBody = z.strictObject({ resolutionKind: z.enum(["release", "refund", "partial", "withdrawn", "other"]), resolution: z.string().trim().min(3).max(4000) });
disputeRoutes.post("/:id/resolve", async (c) => {
  const userId = c.get("auth").userId;
  requirePlatformAdmin(userId); // human review where required (PRD §102): AI never decides liability
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(resolveBody, raw);
  return runIdempotent(c, { scope: "disputes.resolve", userId, body: { id, raw } }, async (tx) => {
    const { d } = await loadDispute(tx, id, userId, true);
    if (["resolved", "closed"].includes(d.status)) throw new ApiError(409, "dispute_closed", "This dispute is already decided");
    await tx.update(disputes).set({ status: "resolved", resolutionKind: b.resolutionKind, resolution: b.resolution, resolvedByUserId: userId, resolvedAt: new Date() }).where(eq(disputes.id, id));
    await releaseScope(tx, d, b.resolutionKind);
    await tx.insert(disputeEntries).values({ disputeId: id, authorUserId: userId, kind: "decision", body: b.resolution });
    await recordActivity(tx, { projectId: d.projectId, actorUserId: userId, eventType: "dispute.resolved", subjectType: "dispute", subjectId: id, payload: { kind: b.resolutionKind } });
    await notify(tx, [d.openedByUserId, d.againstUserId].filter((x): x is string => !!x), "dispute.resolved", { projectId: d.projectId, disputeId: id, kind: b.resolutionKind });
    return { status: 200, body: { dispute: { id, status: "resolved", resolutionKind: b.resolutionKind }, note: "Any money movement is carried out through the payment and refund steps." } };
  });
});

disputeRoutes.post("/:id/withdraw", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  return runIdempotent(c, { scope: "disputes.withdraw", userId, body: { id } }, async (tx) => {
    const { d } = await loadDispute(tx, id, userId, true);
    if (d.openedByUserId !== userId) throw new ApiError(403, "forbidden", "Only the person who opened a dispute can withdraw it");
    if (["resolved", "closed"].includes(d.status)) throw new ApiError(409, "dispute_closed", "This dispute is already decided");
    await tx.update(disputes).set({ status: "closed", resolutionKind: "withdrawn", resolvedByUserId: userId, resolvedAt: new Date() }).where(eq(disputes.id, id));
    await releaseScope(tx, d, "withdrawn");
    await recordActivity(tx, { projectId: d.projectId, actorUserId: userId, eventType: "dispute.withdrawn", subjectType: "dispute", subjectId: id, payload: {} });
    return { status: 200, body: { dispute: { id, status: "closed" } } };
  });
});
