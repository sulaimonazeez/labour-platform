import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { materialResponsibility, projects, serviceCategories, stages, tasks } from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { isProviderOnly, PROJECT_MANAGERS, providerVisibleTaskIds, requireProjectRole } from "../authz/projects";
import { recordActivity } from "../lib/activity";
import { runIdempotent } from "../lib/idempotency";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http";
import { taskCols } from "./task-routes";

export const projectRoutes = new Hono<AuthEnv>();
projectRoutes.use("*", requireAuth);

const createTaskBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000).optional(),
  stageId: z.uuid().optional(),
  categoryKey: z.string().trim().min(1).max(120).optional(),
  materialResponsibility: z.enum(materialResponsibility.enumValues).optional(),
});

// Managers and other members see the whole project. Provider-only members (PRD §34) see only the
// tasks assigned to them, and only the stages that contain those tasks (DECISIONS D31).
projectRoutes.get("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const roles = await requireProjectRole(db, id, userId); // 404 for non-members

  const [project] = await db
    .select({
      id: projects.id, ownerUserId: projects.ownerUserId, organisationId: projects.organisationId,
      requestId: projects.requestId, marketId: projects.marketId, title: projects.title,
      objective: projects.objective, status: projects.status, health: projects.health,
      currency: projects.currency, timezone: projects.timezone,
      currentBaselineVersion: projects.currentBaselineVersion, createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  if (!project) throw new ApiError(404, "not_found", "Not found");

  const providerOnly = isProviderOnly(roles);
  const visible = providerOnly ? await providerVisibleTaskIds(db, id, userId) : null;

  const taskRows = visible && visible.length === 0
    ? []
    : await db
      .select({
        id: tasks.id, stageId: tasks.stageId, categoryId: tasks.categoryId, title: tasks.title,
        description: tasks.description, status: tasks.status,
        materialResponsibility: tasks.materialResponsibility, position: tasks.position,
      })
      .from(tasks)
      .where(visible ? and(eq(tasks.projectId, id), inArray(tasks.id, visible)) : eq(tasks.projectId, id))
      .orderBy(asc(tasks.position));
  const stageIds = new Set(taskRows.map((t) => t.stageId).filter((x): x is string => x !== null));
  const allStages = await db
    .select({ id: stages.id, name: stages.name, position: stages.position, status: stages.status })
    .from(stages)
    .where(eq(stages.projectId, id))
    .orderBy(asc(stages.position));
  const stageRows = providerOnly ? allStages.filter((s) => stageIds.has(s.id)) : allStages;

  return c.json({ project, roles, stages: stageRows, tasks: taskRows });
});

projectRoutes.post("/:id/tasks", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(createTaskBody, raw);

  return runIdempotent(c, { scope: "tasks.create", userId, body: raw }, async (tx) => {
    await requireProjectRole(tx, projectId, userId, PROJECT_MANAGERS); // 404 non-member, 403 wrong role

    const [p] = await tx.select({ status: projects.status }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) throw new ApiError(404, "not_found", "Not found");
    if (p.status === "completed" || p.status === "cancelled") {
      throw new ApiError(409, "project_closed", `A ${p.status} project cannot get new tasks`);
    }

    let stageId: string | null = null;
    if (b.stageId) {
      const [s] = await tx.select({ id: stages.id }).from(stages).where(and(eq(stages.id, b.stageId), eq(stages.projectId, projectId))).limit(1);
      if (!s) throw new ApiError(400, "unknown_stage", "stageId is not a stage of this project");
      stageId = s.id;
    } else {
      const [first] = await tx.select({ id: stages.id }).from(stages).where(eq(stages.projectId, projectId)).orderBy(asc(stages.position)).limit(1);
      stageId = first?.id ?? null;
    }

    let categoryId: string | null = null;
    if (b.categoryKey) {
      const [cat] = await tx
        .select({ id: serviceCategories.id })
        .from(serviceCategories)
        .where(and(eq(serviceCategories.canonicalKey, b.categoryKey), eq(serviceCategories.isActive, true)))
        .limit(1);
      if (!cat) throw new ApiError(400, "unknown_category", "Unknown service category");
      categoryId = cat.id;
    }

    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${tasks.position}), -1) + 1` })
      .from(tasks)
      .where(eq(tasks.projectId, projectId));

    const [row] = await tx
      .insert(tasks)
      .values({
        projectId,
        stageId,
        categoryId,
        title: b.title,
        description: b.description ?? null,
        materialResponsibility: b.materialResponsibility ?? "not_applicable",
        position: Number(next),
      })
      .returning(taskCols);

    await recordActivity(tx, {
      projectId,
      actorUserId: userId,
      eventType: "task.created",
      subjectType: "task",
      subjectId: row.id,
      payload: { title: row.title, stageId, categoryId },
    });
    return { status: 201, body: { task: row } };
  });
});
