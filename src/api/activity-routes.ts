import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { activityEvents, users } from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { isProviderOnly, providerVisibleTaskIds, requireProjectRole } from "../authz/projects";
import { parseOrThrow, uuidParam } from "./http";

// The project timeline (PRD §68, §137): one chronological, read-only record generated from system events. Chat is not in it.
//   GET /projects/:id/activity?limit=50&before=<ISO time>     newest first; `before` pages backwards
// Managers and other non-provider members see the whole project. A provider-only member sees only what happened on
// their own tasks and what they did themselves (PRD §34), so other providers' quotes and prices never leak. D76.

export const activityRoutes = new Hono<AuthEnv>();
activityRoutes.use("*", requireAuth);

const query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime().optional(),
});

activityRoutes.get("/:id/activity", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const q = parseOrThrow(query, { limit: c.req.query("limit"), before: c.req.query("before") });
  const roles = await requireProjectRole(db, projectId, userId); // 404 for non-members

  let scope;
  if (isProviderOnly(roles)) {
    const visible = await providerVisibleTaskIds(db, projectId, userId);
    scope = or(
      eq(activityEvents.actorUserId, userId),
      visible.length > 0 ? and(eq(activityEvents.subjectType, "task"), inArray(activityEvents.subjectId, visible)) : undefined,
      visible.length > 0 ? sql`${activityEvents.payload}->>'taskId' in (${sql.join(visible.map((id) => sql`${id}`), sql`, `)})` : undefined,
    );
  }
  const rows = await db
    .select({
      id: activityEvents.id, eventType: activityEvents.eventType, subjectType: activityEvents.subjectType, subjectId: activityEvents.subjectId,
      payload: activityEvents.payload, occurredAt: activityEvents.occurredAt, actorType: activityEvents.actorType, actorName: users.displayName,
    })
    .from(activityEvents)
    .leftJoin(users, eq(users.id, activityEvents.actorUserId))
    .where(and(eq(activityEvents.projectId, projectId), scope, q.before ? lt(activityEvents.occurredAt, new Date(q.before)) : undefined))
    .orderBy(desc(activityEvents.occurredAt))
    .limit(q.limit + 1);

  const more = rows.length > q.limit;
  const page = more ? rows.slice(0, q.limit) : rows;
  return c.json({ events: page, nextBefore: more ? page[page.length - 1].occurredAt : null });
});
