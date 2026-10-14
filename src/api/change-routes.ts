import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  assignments, changeRequests, changeRequestTasks, projectBaselines, projectBudgets, projects, providerProfiles, tasks, users,
} from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { getProjectRoles, isProviderOnly, PROJECT_MANAGERS, providerVisibleTaskIds, requireProjectRole } from "../authz/projects.js";
import type { Executor } from "../db/types.js";
import { CHANGE_TRANSITIONS, canTransition, type ChangeStatus } from "../engine/state-machines.js";
import { recordActivity } from "../lib/activity.js";
import { runIdempotent } from "../lib/idempotency.js";
import { managerUserIds, notify } from "../lib/notify.js";
import { ApiError, parseOrThrow, pgErrorCode, readJson, uuidParam } from "./http.js";

// Change management (PRD §58-60). Nothing silently edits the agreement: a change is PROPOSED, the OTHER party accepts or
// rejects it, and acceptance creates a NEW baseline in the same transaction (the old one is never edited).
//   POST /projects/:id/changes            propose   (manager, or a provider holding a live assignment on an affected task)
//   GET  /projects/:id/changes            list      (managers see all; a provider sees changes they proposed or that touch their tasks)
//   POST /changes/:id/accept | /reject    the counterparty (see counterpartyOf)
//   POST /changes/:id/withdraw            the proposer, while still proposed
// Decisions D64-D68 in docs/DECISIONS.md.

const LIVE_ASSIGNMENT = ["offered", "accepted", "active"] as const;
const PROVIDER_CAN_PROPOSE = ["accepted", "active"] as const;
const CLOSED_TASK = ["completed", "cancelled"];

const proposeBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(3000).optional(),
  financialEffect: z.enum(["no_cost", "increase", "reduction", "credit", "partial_cancellation"]),
  costDeltaMinor: z.int().min(-1_000_000_000_000_000).max(1_000_000_000_000_000).default(0),
  scheduleDeltaDays: z.int().min(-3650).max(3650).default(0),
  taskIds: z.array(z.uuid()).min(1).max(50),
});
const reasonBody = z.strictObject({ reason: z.string().trim().min(1).max(1000).optional() });

const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do this");

function checkFinancials(effect: string, delta: number) {
  const ok = effect === "no_cost" ? delta === 0 : effect === "increase" ? delta > 0 : delta < 0;
  if (!ok) {
    throw new ApiError(400, "financial_effect_mismatch",
      effect === "no_cost" ? "A no-cost change must have a cost change of 0"
        : effect === "increase" ? "An increase must have a cost change above 0"
        : "A reduction, credit or partial cancellation must have a cost change below 0");
  }
}

/** Providers with a live assignment on any of these tasks. A change may involve at most one (D65). */
async function affectedProviders(ex: Executor, taskIds: string[], statuses: readonly string[]) {
  if (taskIds.length === 0) return [];
  const rows = await ex
    .select({ providerProfileId: assignments.providerProfileId, userId: providerProfiles.userId, taskId: assignments.taskId })
    .from(assignments)
    .innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId))
    .where(and(inArray(assignments.taskId, taskIds), inArray(assignments.status, [...statuses] as never)));
  const byUser = new Map<string, { providerProfileId: string; userId: string }>();
  for (const r of rows) byUser.set(r.userId, { providerProfileId: r.providerProfileId, userId: r.userId });
  return [...byUser.values()];
}

type Counterparty = { kind: "manager" } | { kind: "provider"; userId: string };

/** Who must answer a change. The proposer's own side never answers (except when no provider is involved, D65). */
async function counterpartyOf(ex: Executor, cr: { id: string; projectId: string; requestedByUserId: string }): Promise<Counterparty> {
  const links = await ex.select({ taskId: changeRequestTasks.taskId }).from(changeRequestTasks).where(eq(changeRequestTasks.changeRequestId, cr.id));
  const provs = await affectedProviders(ex, links.map((l) => l.taskId), LIVE_ASSIGNMENT);
  const roles = await getProjectRoles(ex, cr.projectId, cr.requestedByUserId);
  const proposerIsManager = roles.some((r) => PROJECT_MANAGERS.includes(r));
  if (!proposerIsManager) return { kind: "manager" };
  if (provs.length === 0) return { kind: "manager" };
  return { kind: "provider", userId: provs[0].userId };
}

async function mayAnswer(ex: Executor, cr: { id: string; projectId: string; requestedByUserId: string }, userId: string): Promise<boolean> {
  const cp = await counterpartyOf(ex, cr);
  if (cp.kind === "provider") return cp.userId === userId;
  const roles = await getProjectRoles(ex, cr.projectId, userId);
  if (!roles.some((r) => PROJECT_MANAGERS.includes(r))) return false;
  // A manager's change that involves no provider has no counterparty: any manager, the proposer included, may answer.
  const proposerRoles = await getProjectRoles(ex, cr.projectId, cr.requestedByUserId);
  const proposerIsManager = proposerRoles.some((r) => PROJECT_MANAGERS.includes(r));
  return proposerIsManager ? true : userId !== cr.requestedByUserId;
}

async function snapshotOf(ex: Executor, projectId: string, extra: Record<string, unknown>) {
  const ts = await ex.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(tasks).where(eq(tasks.projectId, projectId)).orderBy(asc(tasks.position), asc(tasks.createdAt));
  const [b] = await ex.select({ currency: projectBudgets.currency, estimatedMinor: projectBudgets.estimatedMinor, approvedMinor: projectBudgets.approvedMinor }).from(projectBudgets).where(eq(projectBudgets.projectId, projectId)).limit(1);
  return { tasks: ts, budget: b ?? null, ...extra };
}

export const changeProjectRoutes = new Hono<AuthEnv>();
changeProjectRoutes.use("*", requireAuth);

changeProjectRoutes.post("/:id/changes", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(proposeBody, raw);
  checkFinancials(b.financialEffect, b.costDeltaMinor);
  const taskIds = [...new Set(b.taskIds)];

  return runIdempotent(c, { scope: "changes.propose", userId, body: raw }, async (tx) => {
    const [p] = await tx.select({ id: projects.id, status: projects.status, currency: projects.currency, baseline: projects.currentBaselineVersion })
      .from(projects).where(eq(projects.id, projectId)).limit(1).for("update");
    if (!p) throw new ApiError(404, "not_found", "Not found");
    const roles = await requireProjectRole(tx, projectId, userId);
    if (p.status !== "draft" && p.status !== "active") throw new ApiError(409, "project_not_open", `A ${p.status} project cannot take changes`);

    const isManager = roles.some((r) => PROJECT_MANAGERS.includes(r));
    if (!isManager && !isProviderOnly(roles)) throw forbidden();

    const found = await tx.select({ id: tasks.id, status: tasks.status }).from(tasks).where(and(eq(tasks.projectId, projectId), inArray(tasks.id, taskIds)));
    if (found.length !== taskIds.length) throw new ApiError(400, "task_invalid", "Some tasks do not belong to this project");
    if (found.some((t) => CLOSED_TASK.includes(t.status))) throw new ApiError(409, "task_closed", "A completed or cancelled task cannot be changed");

    if (!isManager) {
      // A provider may only change work they hold: every affected task needs THEIR accepted/active assignment.
      const mine = await affectedProviders(tx, taskIds, PROVIDER_CAN_PROPOSE);
      const own = mine.find((m) => m.userId === userId);
      const held = own
        ? await tx.select({ taskId: assignments.taskId }).from(assignments).where(and(inArray(assignments.taskId, taskIds), eq(assignments.providerProfileId, own.providerProfileId), inArray(assignments.status, [...PROVIDER_CAN_PROPOSE])))
        : [];
      if (new Set(held.map((h) => h.taskId)).size !== taskIds.length) throw forbidden();
    }
    const live = await affectedProviders(tx, taskIds, LIVE_ASSIGNMENT);
    if (live.length > 1) throw new ApiError(400, "one_provider_per_change", "A change can involve one provider's work at a time: split it into separate changes");

    // Original baseline (PRD §59): taken the first time anything is proposed (D66).
    let base = p.baseline;
    if (base === 0) {
      await tx.insert(projectBaselines).values({ projectId, version: 1, snapshot: await snapshotOf(tx, projectId, { capturedBy: "first_change_proposal" }) });
      await tx.update(projects).set({ currentBaselineVersion: 1 }).where(eq(projects.id, projectId));
      base = 1;
    }

    const [cr] = await tx.insert(changeRequests).values({
      projectId, requestedByUserId: userId, status: "proposed", title: b.title, description: b.description ?? null,
      financialEffect: b.financialEffect, costDeltaMinor: b.costDeltaMinor, currency: p.currency,
      scheduleDeltaDays: b.scheduleDeltaDays, baseBaselineVersion: base,
    }).returning();
    await tx.insert(changeRequestTasks).values(taskIds.map((taskId) => ({ changeRequestId: cr.id, taskId })));
    await recordActivity(tx, {
      projectId, actorUserId: userId, eventType: "change.proposed", subjectType: "change_request", subjectId: cr.id,
      payload: { title: b.title, financialEffect: b.financialEffect, costDeltaMinor: b.costDeltaMinor, currency: p.currency, scheduleDeltaDays: b.scheduleDeltaDays, taskIds, baseBaselineVersion: base },
    });

    const cp = await counterpartyOf(tx, cr);
    const who = cp.kind === "provider" ? [cp.userId] : await managerUserIds(tx, projectId);
    await notify(tx, who, "change.proposed", { projectId, changeId: cr.id, title: b.title }, userId);
    return { status: 201, body: { change: { ...cr, taskIds } } };
  });
});

changeProjectRoutes.get("/:id/changes", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const roles = await requireProjectRole(db, projectId, userId);
  const rows = await db
    .select({ cr: changeRequests, proposerName: users.displayName })
    .from(changeRequests)
    .innerJoin(users, eq(users.id, changeRequests.requestedByUserId))
    .where(eq(changeRequests.projectId, projectId))
    .orderBy(desc(changeRequests.createdAt))
    .limit(100);
  const links = rows.length === 0 ? [] : await db.select().from(changeRequestTasks).where(inArray(changeRequestTasks.changeRequestId, rows.map((r) => r.cr.id)));

  let visible = rows;
  if (isProviderOnly(roles)) {
    const mine = new Set(await providerVisibleTaskIds(db, projectId, userId));
    visible = rows.filter((r) => r.cr.requestedByUserId === userId || links.some((l) => l.changeRequestId === r.cr.id && mine.has(l.taskId)));
  }
  const out = [];
  for (const r of visible) {
    const open = r.cr.status === "proposed" || r.cr.status === "under_review";
    out.push({
      ...r.cr, proposerName: r.proposerName,
      taskIds: links.filter((l) => l.changeRequestId === r.cr.id).map((l) => l.taskId),
      youCanRespond: open && (await mayAnswer(db, r.cr, userId)),
      youCanWithdraw: open && r.cr.requestedByUserId === userId,
    });
  }
  return c.json({ changes: out });
});

export const changeRoutes = new Hono<AuthEnv>();
changeRoutes.use("*", requireAuth);

async function loadForAction(tx: Executor, id: string, userId: string) {
  const [cr] = await tx.select().from(changeRequests).where(eq(changeRequests.id, id)).limit(1);
  if (!cr) throw new ApiError(404, "not_found", "Not found");
  await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, cr.projectId)).limit(1).for("update"); // serialises concurrent decisions
  const roles = await getProjectRoles(tx, cr.projectId, userId);
  if (roles.length === 0) throw new ApiError(404, "not_found", "Not found");
  const [fresh] = await tx.select().from(changeRequests).where(eq(changeRequests.id, id)).limit(1).for("update");
  return fresh ?? cr;
}
function needOpen(cr: { status: ChangeStatus }, to: ChangeStatus) {
  if (!canTransition(CHANGE_TRANSITIONS, cr.status, to)) {
    throw new ApiError(409, "illegal_transition", `A ${cr.status} change cannot move to ${to}`, { from: cr.status, to, allowed: CHANGE_TRANSITIONS[cr.status] });
  }
}

changeRoutes.post("/:id/accept", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  parseOrThrow(z.strictObject({}), raw ?? {});

  return runIdempotent(c, { scope: "changes.accept", userId, body: { id } }, async (tx) => {
    const cr = await loadForAction(tx, id, userId);
    if (!(await mayAnswer(tx, cr, userId))) throw forbidden();
    needOpen(cr, "accepted");

    const [p] = await tx.select({ status: projects.status, baseline: projects.currentBaselineVersion }).from(projects).where(eq(projects.id, cr.projectId)).limit(1);
    if (!p || (p.status !== "draft" && p.status !== "active")) throw new ApiError(409, "project_not_open", "This project can no longer take changes");
    if (p.baseline !== cr.baseBaselineVersion) {
      throw new ApiError(409, "baseline_changed", "The agreement changed after this was proposed. Propose it again against the current baseline", { proposedAgainst: cr.baseBaselineVersion, current: p.baseline });
    }
    const links = await tx.select({ taskId: changeRequestTasks.taskId }).from(changeRequestTasks).where(eq(changeRequestTasks.changeRequestId, id));
    const open = await tx.select({ id: tasks.id }).from(tasks).where(and(inArray(tasks.id, links.map((l) => l.taskId)), inArray(tasks.status, CLOSED_TASK as never)));
    if (open.length > 0) throw new ApiError(409, "task_closed", "A task in this change was completed or cancelled meanwhile");

    // Budget: only an approved budget that exists is adjusted (D67). Milestones and payments are NOT touched.
    const [bud] = await tx.select({ approved: projectBudgets.approvedMinor }).from(projectBudgets).where(eq(projectBudgets.projectId, cr.projectId)).limit(1).for("update");
    let approvedAfter: number | null = bud?.approved ?? null;
    if (bud && bud.approved !== null && cr.costDeltaMinor !== 0) {
      approvedAfter = bud.approved + cr.costDeltaMinor;
      if (approvedAfter < 0) throw new ApiError(409, "budget_below_zero", "This reduction is larger than the approved budget");
      await tx.update(projectBudgets).set({ approvedMinor: approvedAfter, updatedAt: new Date() }).where(eq(projectBudgets.projectId, cr.projectId));
    }

    const version = p.baseline + 1;
    await tx.update(changeRequests).set({ status: "accepted" }).where(eq(changeRequests.id, id));
    try {
      await tx.insert(projectBaselines).values({
        projectId: cr.projectId, version, createdByChangeRequestId: id,
        snapshot: await snapshotOf(tx, cr.projectId, {
          appliedChange: { id, title: cr.title, financialEffect: cr.financialEffect, costDeltaMinor: cr.costDeltaMinor, currency: cr.currency, scheduleDeltaDays: cr.scheduleDeltaDays, taskIds: links.map((l) => l.taskId) },
        }),
      });
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw new ApiError(409, "baseline_changed", "The agreement changed at the same moment. Try again");
      throw e;
    }
    await tx.update(projects).set({ currentBaselineVersion: version, updatedAt: new Date() }).where(eq(projects.id, cr.projectId));
    const [applied] = await tx.update(changeRequests).set({ status: "applied", resultingBaselineVersion: version }).where(eq(changeRequests.id, id)).returning();

    await recordActivity(tx, { projectId: cr.projectId, actorUserId: userId, eventType: "change.accepted", subjectType: "change_request", subjectId: id, payload: { baselineVersion: version, approvedBudgetMinor: approvedAfter } });
    await recordActivity(tx, { projectId: cr.projectId, actorUserId: userId, eventType: "change.applied", subjectType: "change_request", subjectId: id, payload: { resultingBaselineVersion: version, costDeltaMinor: cr.costDeltaMinor, currency: cr.currency, scheduleDeltaDays: cr.scheduleDeltaDays } });
    await notify(tx, [cr.requestedByUserId], "change.accepted", { projectId: cr.projectId, changeId: id, title: cr.title }, userId);
    return { status: 200, body: { change: { ...applied, taskIds: links.map((l) => l.taskId) }, baselineVersion: version } };
  });
});

changeRoutes.post("/:id/reject", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(reasonBody, raw ?? {});

  return runIdempotent(c, { scope: "changes.reject", userId, body: { id, ...b } }, async (tx) => {
    const cr = await loadForAction(tx, id, userId);
    if (!(await mayAnswer(tx, cr, userId))) throw forbidden();
    needOpen(cr, "rejected");
    const [row] = await tx.update(changeRequests).set({ status: "rejected" }).where(eq(changeRequests.id, id)).returning();
    await recordActivity(tx, { projectId: cr.projectId, actorUserId: userId, eventType: "change.rejected", subjectType: "change_request", subjectId: id, payload: { reason: b.reason ?? null } });
    await notify(tx, [cr.requestedByUserId], "change.rejected", { projectId: cr.projectId, changeId: id, title: cr.title }, userId);
    return { status: 200, body: { change: row } };
  });
});

changeRoutes.post("/:id/withdraw", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  parseOrThrow(z.strictObject({}), raw ?? {});

  return runIdempotent(c, { scope: "changes.withdraw", userId, body: { id } }, async (tx) => {
    const cr = await loadForAction(tx, id, userId);
    if (cr.requestedByUserId !== userId) throw forbidden();
    needOpen(cr, "withdrawn");
    const [row] = await tx.update(changeRequests).set({ status: "withdrawn" }).where(eq(changeRequests.id, id)).returning();
    await recordActivity(tx, { projectId: cr.projectId, actorUserId: userId, eventType: "change.withdrawn", subjectType: "change_request", subjectId: id, payload: {} });
    return { status: 200, body: { change: row } };
  });
});
