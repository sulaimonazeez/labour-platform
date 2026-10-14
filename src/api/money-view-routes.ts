import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client.js";
import { assignments, milestones, payments, providerProfiles, quoteVersions, quotes, tasks } from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { isProviderOnly, PROJECT_MANAGERS, requireProjectRole, type ProjectRole } from "../authz/projects.js";
import { ApiError, uuidParam } from "./http.js";

// Read-only money views for the project screen (PRD §56, §57, §143). Only people with a money role see them.
//   GET /projects/:id/awards     accepted providers, their agreed quote, and how much is not yet split into milestones
//   GET /projects/:id/payments   payments of the project (never the gateway reference)
// Provider-only members get 404, so a provider cannot learn what a project pays anyone else.

const MONEY_ROLES: readonly ProjectRole[] = [...PROJECT_MANAGERS, "finance_approver"];

async function requireMoneyView(projectId: string, userId: string) {
  const roles = await requireProjectRole(db, projectId, userId);
  if (isProviderOnly(roles)) throw new ApiError(404, "not_found", "Not found");
  if (!roles.some((r) => MONEY_ROLES.includes(r))) throw new ApiError(403, "forbidden", "You do not have permission to do this");
}

export const projectMoneyViewRoutes = new Hono<AuthEnv>();
projectMoneyViewRoutes.use("*", requireAuth);

projectMoneyViewRoutes.get("/:id/awards", async (c) => {
  const projectId = uuidParam(c.req.param("id"));
  await requireMoneyView(projectId, c.get("auth").userId);

  const rows = await db
    .select({
      assignmentId: assignments.id, status: assignments.status, taskId: tasks.id, taskTitle: tasks.title,
      providerName: providerProfiles.displayName, agreedMinor: quoteVersions.totalMinor, currency: quoteVersions.currency,
    })
    .from(assignments)
    .innerJoin(tasks, eq(tasks.id, assignments.taskId))
    .innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId))
    .leftJoin(quotes, eq(quotes.id, assignments.quoteId))
    .leftJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.acceptedVersion)))
    .where(and(eq(tasks.projectId, projectId), inArray(assignments.status, ["accepted", "active"])))
    .orderBy(asc(assignments.offeredAt));

  const ids = rows.map((r) => r.assignmentId);
  const planned = ids.length === 0
    ? []
    : await db
      .select({ assignmentId: milestones.assignmentId, total: sql<string>`coalesce(sum(${milestones.amountMinor}), 0)::text` })
      .from(milestones)
      .where(and(eq(milestones.projectId, projectId), inArray(milestones.assignmentId, ids), sql`${milestones.status} <> 'cancelled'`))
      .groupBy(milestones.assignmentId);

  const awards = rows
    .filter((r) => r.agreedMinor !== null && r.currency !== null) // a milestone needs an agreed quote
    .map((r) => {
      const plannedMinor = Number(planned.find((p) => p.assignmentId === r.assignmentId)?.total ?? "0");
      const agreedMinor = r.agreedMinor as number;
      return {
        assignmentId: r.assignmentId,
        status: r.status,
        task: { id: r.taskId, title: r.taskTitle },
        providerName: r.providerName,
        agreedMinor,
        currency: r.currency as string,
        plannedMinor,
        remainingMinor: Math.max(0, agreedMinor - plannedMinor),
      };
    });
  return c.json({ awards });
});

projectMoneyViewRoutes.get("/:id/payments", async (c) => {
  const projectId = uuidParam(c.req.param("id"));
  await requireMoneyView(projectId, c.get("auth").userId);
  const rows = await db
    .select({
      id: payments.id, milestoneId: payments.milestoneId, state: payments.state, amountMinor: payments.amountMinor,
      currency: payments.currency, releasedMinor: payments.releasedMinor, createdAt: payments.createdAt,
    })
    .from(payments)
    .where(eq(payments.projectId, projectId))
    .orderBy(desc(payments.createdAt))
    .limit(200);
  return c.json({ payments: rows });
});
