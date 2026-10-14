import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { assignments, evidence, milestones, projects, providerProfiles, taskDependencies, tasks } from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { isProviderOnly, PROJECT_MANAGERS, requireProjectRole } from "../authz/projects.js";
import type { Executor } from "../db/types.js";
import { canTransition, TASK_TRANSITIONS, type TaskStatus } from "../engine/state-machines.js";
import { recordActivity } from "../lib/activity.js";
import { runIdempotent } from "../lib/idempotency.js";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http.js";

// Task work lifecycle (PRD §65, §134; DECISIONS D41-D44).
//   provider: POST /tasks/:id/start, POST /tasks/:id/submit
//   manager:  POST /tasks/:id/request-changes, /approve, /complete
// accepted -> in_progress -> submitted -> approved -> completed (submitted -> in_progress when changes are requested).

export const taskWorkRoutes = new Hono<AuthEnv>();
taskWorkRoutes.use("*", requireAuth);

const noteBody = z.strictObject({ note: z.string().trim().min(1).max(1000).optional() });
const reasonBody = z.strictObject({ reason: z.string().trim().min(1).max(1000) });

const STARTED: readonly TaskStatus[] = ["in_progress", "submitted", "approved", "completed"];

function move(from: TaskStatus, to: TaskStatus) {
  if (!canTransition(TASK_TRANSITIONS, from, to)) {
    throw new ApiError(409, "illegal_transition", `A ${from} task cannot move to ${to}`, { from, to, allowed: TASK_TRANSITIONS[from] });
  }
}

type TaskRow = { id: string; projectId: string; status: TaskStatus; evidenceRequirements: Record<string, unknown> };

async function lockTask(ex: Executor, id: string): Promise<TaskRow> {
  const [t] = await ex
    .select({ id: tasks.id, projectId: tasks.projectId, status: tasks.status, evidenceRequirements: tasks.evidenceRequirements })
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1)
    .for("update");
  if (!t) throw new ApiError(404, "not_found", "Not found");
  return t;
}

async function peekProject(ex: Executor, id: string): Promise<string> {
  const [t] = await ex.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!t) throw new ApiError(404, "not_found", "Not found");
  return t.projectId;
}

async function projectOpen(ex: Executor, projectId: string) {
  const [p] = await ex.select({ status: projects.status }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) throw new ApiError(404, "not_found", "Not found");
  if (p.status !== "draft" && p.status !== "active") throw new ApiError(409, "project_not_open", `A ${p.status} project cannot change task work`);
}

/** The caller's own assignment on this task, locked. Not theirs: provider-only members get 404, others 403 (PRD §34). */
async function myAssignment(ex: Executor, taskId: string, userId: string, projectId: string, roles: readonly string[]) {
  const [a] = await ex
    .select({ id: assignments.id, status: assignments.status })
    .from(assignments)
    .innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId))
    .where(and(eq(assignments.taskId, taskId), eq(providerProfiles.userId, userId), inArray(assignments.status, ["accepted", "active"])))
    .limit(1)
    .for("update", { of: assignments });
  if (!a) {
    if (isProviderOnly(roles as any)) throw new ApiError(404, "not_found", "Not found");
    throw new ApiError(403, "forbidden", "You do not have permission to do this");
  }
  void projectId;
  return a;
}

/** Number of dependencies that are not satisfied yet. Only finish_to_start and start_to_start are machine-checkable. */
async function unmetDependencies(ex: Executor, taskId: string): Promise<number> {
  const deps = await ex
    .select({ type: taskDependencies.type, status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(eq(taskDependencies.taskId, taskId));
  let unmet = 0;
  for (const d of deps) {
    if (d.type === "finish_to_start" && d.status !== "completed") unmet++;
    if (d.type === "start_to_start" && !STARTED.includes(d.status)) unmet++;
  }
  return unmet;
}

async function taskEvidenceCount(ex: Executor, t: TaskRow) {
  const r = t.evidenceRequirements;
  const required = typeof r.minCount === "number" ? r.minCount : 0;
  const kinds = Array.isArray(r.kinds) ? (r.kinds as string[]) : [];
  const conds = [eq(evidence.taskId, t.id)];
  if (kinds.length > 0) conds.push(inArray(evidence.kind, kinds as any));
  const [row] = await ex.select({ n: sql<number>`count(*)::int` }).from(evidence).where(and(...conds));
  return { required, kinds, have: Number(row?.n ?? 0) };
}

async function transitioned(ex: Executor, projectId: string, userId: string, taskId: string, from: TaskStatus, to: TaskStatus, via: string, extra: Record<string, unknown> = {}) {
  await recordActivity(ex, {
    projectId, actorUserId: userId, eventType: "task.transitioned", subjectType: "task", subjectId: taskId,
    payload: { from, to, via, ...extra },
  });
}

taskWorkRoutes.post("/:id/start", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  parseOrThrow(noteBody, raw ?? {});

  return runIdempotent(c, { scope: "tasks.start", userId, body: raw }, async (tx) => {
    const projectId = await peekProject(tx, id);
    const roles = await requireProjectRole(tx, projectId, userId);
    const t = await lockTask(tx, id);
    const a = await myAssignment(tx, id, userId, projectId, roles);
    await projectOpen(tx, projectId);
    move(t.status, "in_progress");
    if (t.status !== "accepted") throw new ApiError(409, "task_not_accepted", "Only an accepted task can be started", { taskStatus: t.status });
    if (a.status !== "accepted") throw new ApiError(409, "assignment_not_accepted", "The assignment must be accepted before work starts", { assignmentStatus: a.status });
    const unmet = await unmetDependencies(tx, id);
    if (unmet > 0) throw new ApiError(409, "dependencies_not_met", "Work this task depends on is not finished yet", { unmetCount: unmet });

    const now = new Date();
    await tx.update(tasks).set({ status: "in_progress", actualStart: now }).where(eq(tasks.id, id));
    await tx.update(assignments).set({ status: "active" }).where(eq(assignments.id, a.id));
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: "task.started", subjectType: "task", subjectId: id, payload: { assignmentId: a.id } });
    await transitioned(tx, projectId, userId, id, t.status, "in_progress", "work_started");
    return { status: 200, body: { task: { id, status: "in_progress", actualStart: now }, assignment: { id: a.id, status: "active" } } };
  });
});

taskWorkRoutes.post("/:id/submit", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(noteBody, raw ?? {});

  return runIdempotent(c, { scope: "tasks.submit", userId, body: raw }, async (tx) => {
    const projectId = await peekProject(tx, id);
    const roles = await requireProjectRole(tx, projectId, userId);
    const t = await lockTask(tx, id);
    const a = await myAssignment(tx, id, userId, projectId, roles);
    await projectOpen(tx, projectId);
    move(t.status, "submitted");
    if (a.status !== "active") throw new ApiError(409, "assignment_not_active", "The assignment is not active", { assignmentStatus: a.status });
    const progress = await taskEvidenceCount(tx, t);
    if (progress.have < progress.required) {
      throw new ApiError(409, "evidence_requirements_not_met", "Not enough evidence has been added for this task", progress);
    }
    await tx.update(tasks).set({ status: "submitted" }).where(eq(tasks.id, id));
    await recordActivity(tx, {
      projectId, actorUserId: userId, eventType: "task.submitted", subjectType: "task", subjectId: id,
      payload: { evidenceCount: progress.have, ...(b.note ? { note: b.note } : {}) },
    });
    await transitioned(tx, projectId, userId, id, t.status, "submitted", "work_submitted");
    return { status: 200, body: { task: { id, status: "submitted" } } };
  });
});

taskWorkRoutes.post("/:id/request-changes", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(reasonBody, raw);

  return runIdempotent(c, { scope: "tasks.request_changes", userId, body: raw }, async (tx) => {
    const projectId = await peekProject(tx, id);
    await requireProjectRole(tx, projectId, userId, PROJECT_MANAGERS);
    const t = await lockTask(tx, id);
    await projectOpen(tx, projectId);
    move(t.status, "in_progress");
    if (t.status !== "submitted") throw new ApiError(409, "task_not_submitted", "Only submitted work can be sent back", { taskStatus: t.status });
    await tx.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, id));
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: "task.changes_requested", subjectType: "task", subjectId: id, payload: { reason: b.reason } });
    await transitioned(tx, projectId, userId, id, t.status, "in_progress", "changes_requested");
    return { status: 200, body: { task: { id, status: "in_progress" } } };
  });
});

taskWorkRoutes.post("/:id/approve", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(noteBody, raw ?? {});

  return runIdempotent(c, { scope: "tasks.approve", userId, body: raw }, async (tx) => {
    const projectId = await peekProject(tx, id);
    await requireProjectRole(tx, projectId, userId, PROJECT_MANAGERS);
    const t = await lockTask(tx, id);
    await projectOpen(tx, projectId);
    move(t.status, "approved");
    await tx.update(tasks).set({ status: "approved" }).where(eq(tasks.id, id));
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: "task.approved", subjectType: "task", subjectId: id, payload: b.note ? { note: b.note } : {} });
    await transitioned(tx, projectId, userId, id, t.status, "approved", "work_approved");
    return { status: 200, body: { task: { id, status: "approved" } } };
  });
});

taskWorkRoutes.post("/:id/complete", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  parseOrThrow(noteBody, raw ?? {});

  return runIdempotent(c, { scope: "tasks.complete", userId, body: raw }, async (tx) => {
    const projectId = await peekProject(tx, id);
    await requireProjectRole(tx, projectId, userId, PROJECT_MANAGERS);
    const t = await lockTask(tx, id);
    await projectOpen(tx, projectId);
    move(t.status, "completed");

    const [asg] = await tx
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.taskId, id), eq(assignments.status, "active")))
      .limit(1)
      .for("update");
    if (asg) {
      const open = await tx
        .select({ id: milestones.id })
        .from(milestones)
        .where(and(eq(milestones.assignmentId, asg.id), sql`${milestones.status} not in ('approved','released','cancelled')`));
      if (open.length > 0) throw new ApiError(409, "milestones_open", "Every milestone of this assignment must be approved or cancelled first", { openCount: open.length });
      await tx.update(assignments).set({ status: "completed" }).where(eq(assignments.id, asg.id));
    }
    const now = new Date();
    await tx.update(tasks).set({ status: "completed", actualEnd: now }).where(eq(tasks.id, id));
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: "task.completed", subjectType: "task", subjectId: id, payload: asg ? { assignmentId: asg.id } : {} });
    await transitioned(tx, projectId, userId, id, t.status, "completed", "work_completed");
    return { status: 200, body: { task: { id, status: "completed", actualEnd: now } } };
  });
});

