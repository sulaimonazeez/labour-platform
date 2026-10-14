import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  assignments, projectMembers, projects, providerProfiles, quoteVersions, quotes, taskInvitations, tasks,
} from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import type { Executor } from "../db/types.js";
import { canTransition, TASK_TRANSITIONS } from "../engine/state-machines.js";
import { recordActivity } from "../lib/activity.js";
import { runIdempotent } from "../lib/idempotency.js";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http.js";

// Provider response to an award (PRD §65, §95; DECISIONS D35-D36).
//   GET  /assignments              provider workspace: my assignments
//   POST /assignments/:id/accept   offered -> accepted; task assigned -> accepted
//   POST /assignments/:id/reject   offered -> rejected; task assigned -> offered (bidding reopens)
// Only the provider who owns the assignment can respond. Anyone else gets 404 (no existence leak).

export const assignmentRoutes = new Hono<AuthEnv>();
assignmentRoutes.use("*", requireAuth);

const emptyBody = z.strictObject({});
const rejectBody = z.strictObject({ reason: z.string().trim().min(1).max(1000).optional() });
const LIVE_FOR_MEMBERSHIP = ["offered", "accepted", "active", "completed"] as const;

const statusFilter = z.enum(["offered", "accepted", "rejected", "withdrawn", "active", "completed", "cancelled"]);

assignmentRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const rawStatus = c.req.query("status");
  const status = rawStatus === undefined ? undefined : parseOrThrow(statusFilter, rawStatus);

  const rows = await db
    .select({
      id: assignments.id,
      status: assignments.status,
      offeredAt: assignments.offeredAt,
      respondedAt: assignments.respondedAt,
      quoteId: assignments.quoteId,
      taskId: tasks.id,
      taskTitle: tasks.title,
      taskStatus: tasks.status,
      projectId: projects.id,
      projectTitle: projects.title,
      projectCurrency: projects.currency,
      projectTimezone: projects.timezone,
      totalMinor: quoteVersions.totalMinor,
      quoteCurrency: quoteVersions.currency,
    })
    .from(assignments)
    .innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId))
    .innerJoin(tasks, eq(tasks.id, assignments.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(quotes, eq(quotes.id, assignments.quoteId))
    .leftJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.acceptedVersion)))
    .where(and(eq(providerProfiles.userId, userId), status ? eq(assignments.status, status) : undefined))
    .orderBy(desc(assignments.offeredAt))
    .limit(100);

  return c.json({
    assignments: rows.map((r) => ({
      id: r.id,
      status: r.status,
      offeredAt: r.offeredAt,
      respondedAt: r.respondedAt,
      quoteId: r.quoteId,
      agreedTotalMinor: r.totalMinor,
      agreedCurrency: r.quoteCurrency,
      task: { id: r.taskId, title: r.taskTitle, status: r.taskStatus },
      project: { id: r.projectId, title: r.projectTitle, currency: r.projectCurrency, timezone: r.projectTimezone },
    })),
  });
});

type Loaded = { id: string; taskId: string; providerProfileId: string; status: string };

/** The assignment, only if it belongs to the caller. Everything else is "not found". */
async function loadMine(ex: Executor, id: string, userId: string, lock: boolean): Promise<Loaded> {
  const q = ex
    .select({ id: assignments.id, taskId: assignments.taskId, providerProfileId: assignments.providerProfileId, status: assignments.status })
    .from(assignments)
    .innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId))
    .where(and(eq(assignments.id, id), eq(providerProfiles.userId, userId)))
    .limit(1);
  const [row] = lock ? await q.for("update", { of: assignments }) : await q;
  if (!row) throw new ApiError(404, "not_found", "Not found");
  return row;
}

async function openTask(ex: Executor, taskId: string) {
  // Lock order everywhere: task first, then assignment (same as quote accept).
  const [t] = await ex
    .select({ id: tasks.id, projectId: tasks.projectId, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
    .for("update");
  if (!t) throw new ApiError(404, "not_found", "Not found");
  const [p] = await ex.select({ status: projects.status }).from(projects).where(eq(projects.id, t.projectId)).limit(1);
  if (!p) throw new ApiError(404, "not_found", "Not found");
  if (p.status !== "draft" && p.status !== "active") {
    throw new ApiError(409, "project_not_open", `A ${p.status} project cannot take assignment responses`);
  }
  return t;
}

function needOffered(a: Loaded, taskStatus: string) {
  if (a.status !== "offered") {
    throw new ApiError(409, "assignment_not_offered", "This assignment is no longer waiting for your response", { assignmentStatus: a.status });
  }
  if (taskStatus !== "assigned") {
    throw new ApiError(409, "task_not_assigned", "This task is not in the assigned state", { taskStatus });
  }
}

assignmentRoutes.post("/:id/accept", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  parseOrThrow(emptyBody, raw ?? {});

  return runIdempotent(c, { scope: "assignments.accept", userId, body: raw }, async (tx) => {
    const first = await loadMine(tx, id, userId, false);
    const task = await openTask(tx, first.taskId);
    const a = await loadMine(tx, id, userId, true);
    needOffered(a, task.status);
    if (!canTransition(TASK_TRANSITIONS, "assigned", "accepted")) throw new ApiError(500, "internal", "assigned -> accepted must be legal");

    const [updated] = await tx
      .update(assignments)
      .set({ status: "accepted", respondedAt: new Date() })
      .where(eq(assignments.id, id))
      .returning({ id: assignments.id, taskId: assignments.taskId, providerProfileId: assignments.providerProfileId, quoteId: assignments.quoteId, status: assignments.status, offeredAt: assignments.offeredAt, respondedAt: assignments.respondedAt });
    await tx.update(tasks).set({ status: "accepted" }).where(eq(tasks.id, task.id));

    await recordActivity(tx, {
      projectId: task.projectId, actorUserId: userId, eventType: "assignment.accepted", subjectType: "assignment", subjectId: id,
      payload: { taskId: task.id, quoteId: updated.quoteId },
    });
    await recordActivity(tx, {
      projectId: task.projectId, actorUserId: userId, eventType: "task.transitioned", subjectType: "task", subjectId: task.id,
      payload: { from: "assigned", to: "accepted", via: "assignment_accepted" },
    });
    return { status: 200, body: { assignment: updated, task: { id: task.id, status: "accepted" } } };
  });
});

assignmentRoutes.post("/:id/reject", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(rejectBody, raw ?? {});

  return runIdempotent(c, { scope: "assignments.reject", userId, body: raw }, async (tx) => {
    const first = await loadMine(tx, id, userId, false);
    const task = await openTask(tx, first.taskId);
    const a = await loadMine(tx, id, userId, true);
    needOffered(a, task.status);
    if (!canTransition(TASK_TRANSITIONS, "assigned", "offered")) throw new ApiError(500, "internal", "assigned -> offered must be legal");

    const [updated] = await tx
      .update(assignments)
      .set({ status: "rejected", respondedAt: new Date() })
      .where(eq(assignments.id, id))
      .returning({ id: assignments.id, taskId: assignments.taskId, providerProfileId: assignments.providerProfileId, quoteId: assignments.quoteId, status: assignments.status, offeredAt: assignments.offeredAt, respondedAt: assignments.respondedAt });
    await tx.update(tasks).set({ status: "offered" }).where(eq(tasks.id, task.id));
    await tx
      .update(taskInvitations)
      .set({ status: "declined" })
      .where(and(eq(taskInvitations.taskId, task.id), eq(taskInvitations.providerProfileId, a.providerProfileId)));

    // The provider joined the project when the quote was accepted. Drop that membership unless they
    // still hold another live assignment in the same project (PRD §34: no access without a reason).
    const stillLive = await tx
      .select({ id: assignments.id })
      .from(assignments)
      .innerJoin(tasks, eq(tasks.id, assignments.taskId))
      .where(
        and(
          eq(tasks.projectId, task.projectId),
          eq(assignments.providerProfileId, a.providerProfileId),
          inArray(assignments.status, [...LIVE_FOR_MEMBERSHIP]),
        ),
      )
      .limit(1);
    if (stillLive.length === 0) {
      await tx
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, task.projectId), eq(projectMembers.userId, userId), eq(projectMembers.role, "provider")));
    }

    await recordActivity(tx, {
      projectId: task.projectId, actorUserId: userId, eventType: "assignment.rejected", subjectType: "assignment", subjectId: id,
      payload: { taskId: task.id, quoteId: updated.quoteId, ...(b.reason ? { reason: b.reason } : {}) },
    });
    await recordActivity(tx, {
      projectId: task.projectId, actorUserId: userId, eventType: "task.transitioned", subjectType: "task", subjectId: task.id,
      payload: { from: "assigned", to: "offered", via: "assignment_rejected" },
    });
    return { status: 200, body: { assignment: updated, task: { id: task.id, status: "offered" } } };
  });
});
