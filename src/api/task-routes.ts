import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { dependencyType, projects, taskDependencies, tasks, taskStatus } from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { isProviderOnly, PROJECT_MANAGERS, providerVisibleTaskIds, requireProjectRole } from "../authz/projects.js";
import { wouldCreateCycle } from "../engine/dependencies.js";
import { canTransition, TASK_TRANSITIONS, type TaskStatus } from "../engine/state-machines.js";
import { recordActivity } from "../lib/activity.js";
import { runIdempotent } from "../lib/idempotency.js";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http.js";

export const taskCols = {
  id: tasks.id,
  projectId: tasks.projectId,
  stageId: tasks.stageId,
  categoryId: tasks.categoryId,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  materialResponsibility: tasks.materialResponsibility,
  position: tasks.position,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

// Transitions a project manager may perform directly (DECISIONS D26). Every other legal transition
// in TASK_TRANSITIONS belongs to its own workflow (offer/assignment, evidence, approval, change request, dispute).
const MANUAL = new Set<string>([
  "draft>ready", "ready>blocked", "blocked>ready",
  "draft>cancelled", "ready>cancelled", "blocked>cancelled",
]);

const dependencyBody = z.strictObject({
  dependsOnTaskId: z.uuid(),
  type: z.enum(dependencyType.enumValues).optional(),
});

const transitionBody = z.strictObject({ to: z.enum(taskStatus.enumValues) });

export const taskRoutes = new Hono<AuthEnv>();
taskRoutes.use("*", requireAuth);

taskRoutes.get("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const [t] = await db.select(taskCols).from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!t) throw new ApiError(404, "not_found", "Not found");
  const roles = await requireProjectRole(db, t.projectId, userId); // non-members: same 404
  if (isProviderOnly(roles)) {
    // PRD §34: a provider sees only tasks assigned to them; others look nonexistent. No dependency graph either.
    const visible = await providerVisibleTaskIds(db, t.projectId, userId);
    if (!visible.includes(id)) throw new ApiError(404, "not_found", "Not found");
    return c.json({ task: t, roles, dependsOn: [], blocks: [] });
  }
  const dependsOn = await db
    .select({ taskId: taskDependencies.dependsOnTaskId, type: taskDependencies.type })
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, id));
  const blocks = await db
    .select({ taskId: taskDependencies.taskId, type: taskDependencies.type })
    .from(taskDependencies)
    .where(eq(taskDependencies.dependsOnTaskId, id));
  return c.json({ task: t, roles, dependsOn, blocks });
});

taskRoutes.post("/:id/dependencies", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(dependencyBody, raw);
  const type = b.type ?? "finish_to_start";

  return runIdempotent(c, { scope: "tasks.add_dependency", userId, body: raw }, async (tx) => {
    const [t] = await tx.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!t) throw new ApiError(404, "not_found", "Not found");
    await requireProjectRole(tx, t.projectId, userId, PROJECT_MANAGERS);

    // Serialise dependency edits per project so two concurrent requests cannot jointly create a cycle.
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, t.projectId)).for("update");

    const [other] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, b.dependsOnTaskId), eq(tasks.projectId, t.projectId)))
      .limit(1);
    // Same answer for "does not exist" and "belongs to another project": no existence leak.
    if (!other) throw new ApiError(400, "dependency_invalid", "dependsOnTaskId must be a task in the same project");

    const edges = await tx
      .select({ taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId, type: taskDependencies.type })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(eq(tasks.projectId, t.projectId));

    if (edges.some((e) => e.taskId === taskId && e.dependsOnTaskId === b.dependsOnTaskId && e.type === type)) {
      throw new ApiError(409, "dependency_exists", "This dependency already exists");
    }
    if (wouldCreateCycle(edges, taskId, b.dependsOnTaskId)) {
      throw new ApiError(409, "dependency_cycle", "This dependency would create a cycle");
    }

    await tx.insert(taskDependencies).values({ taskId, dependsOnTaskId: b.dependsOnTaskId, type });
    await recordActivity(tx, {
      projectId: t.projectId,
      actorUserId: userId,
      eventType: "task.dependency_added",
      subjectType: "task",
      subjectId: taskId,
      payload: { dependsOnTaskId: b.dependsOnTaskId, type },
    });
    return { status: 201, body: { dependency: { taskId, dependsOnTaskId: b.dependsOnTaskId, type } } };
  });
});

taskRoutes.post("/:id/transition", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(transitionBody, raw);

  return runIdempotent(c, { scope: "tasks.transition", userId, body: raw }, async (tx) => {
    // Row lock: concurrent transitions of one task serialise, and the second sees the new state.
    const [t] = await tx.select(taskCols).from(tasks).where(eq(tasks.id, taskId)).limit(1).for("update");
    if (!t) throw new ApiError(404, "not_found", "Not found");
    await requireProjectRole(tx, t.projectId, userId, PROJECT_MANAGERS);

    const from: TaskStatus = t.status;
    const to: TaskStatus = b.to;
    if (!canTransition(TASK_TRANSITIONS, from, to)) {
      throw new ApiError(409, "illegal_transition", `A ${from} task cannot move to ${to}`, {
        from, to, allowed: TASK_TRANSITIONS[from],
      });
    }
    if (!MANUAL.has(`${from}>${to}`)) {
      throw new ApiError(403, "transition_reserved", "This change happens through its own workflow (offer, assignment, evidence, approval or change request)", { from, to });
    }

    const [updated] = await tx.update(tasks).set({ status: to }).where(eq(tasks.id, taskId)).returning(taskCols);
    await recordActivity(tx, {
      projectId: t.projectId,
      actorUserId: userId,
      eventType: "task.transitioned",
      subjectType: "task",
      subjectId: taskId,
      payload: { from, to },
    });
    return { status: 200, body: { task: updated } };
  });
});
