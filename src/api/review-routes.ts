import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { assignments, projects, providerProfiles, reviews, tasks } from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { PROJECT_MANAGERS, requireProjectRole } from "../authz/projects.js";
import { recordActivity } from "../lib/activity.js";
import { runIdempotent } from "../lib/idempotency.js";
import { notify } from "../lib/notify.js";
import { ApiError, parseOrThrow, pgErrorCode, readJson, uuidParam } from "./http.js";

// Reviews (PRD §91-92): several dimensions, not one star rating; only after the provider COMPLETED work in the project.
//   GET  /projects/:id/reviews       manager: providers who finished work here and whether you already reviewed them
//   POST /projects/:id/reviews       manager: one review per (project, reviewer, provider)
//   GET  /providers/:id/reviews      anyone signed in: counts + averages + recent comments; reviewer identity is never shown
// Decisions D69-D70 in docs/DECISIONS.md.

const rating = z.int().min(1).max(5).optional();
const reviewBody = z.strictObject({
  providerProfileId: z.uuid(),
  workmanship: rating, punctuality: rating, communication: rating, professionalism: rating, quoteAccuracy: rating,
  comment: z.string().trim().min(1).max(2000).optional(),
});

const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do this");

export const reviewProjectRoutes = new Hono<AuthEnv>();
reviewProjectRoutes.use("*", requireAuth);

async function finishedProviders(ex: typeof db, projectId: string) {
  return ex
    .selectDistinct({ providerProfileId: providerProfiles.id, displayName: providerProfiles.displayName })
    .from(assignments)
    .innerJoin(tasks, eq(tasks.id, assignments.taskId))
    .innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId))
    .where(and(eq(tasks.projectId, projectId), eq(assignments.status, "completed")));
}

reviewProjectRoutes.get("/:id/reviews", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const roles = await requireProjectRole(db, projectId, userId);
  if (!roles.some((r) => PROJECT_MANAGERS.includes(r))) throw forbidden();
  const done = await finishedProviders(db, projectId);
  const mine = await db.select({ providerProfileId: reviews.providerProfileId }).from(reviews).where(and(eq(reviews.projectId, projectId), eq(reviews.reviewerUserId, userId)));
  const reviewed = new Set(mine.map((m) => m.providerProfileId));
  return c.json({ providers: done.map((d) => ({ ...d, reviewed: reviewed.has(d.providerProfileId) })) });
});

reviewProjectRoutes.post("/:id/reviews", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(reviewBody, raw);
  if (b.workmanship === undefined && b.punctuality === undefined && b.communication === undefined && b.professionalism === undefined && b.quoteAccuracy === undefined) {
    throw new ApiError(400, "rating_required", "Give at least one rating from 1 to 5");
  }

  return runIdempotent(c, { scope: "reviews.create", userId, body: { projectId, ...b } }, async (tx) => {
    const roles = await requireProjectRole(tx, projectId, userId);
    if (!roles.some((r) => PROJECT_MANAGERS.includes(r))) throw forbidden();
    const [p] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) throw new ApiError(404, "not_found", "Not found");
    const done = await finishedProviders(tx as unknown as typeof db, projectId);
    if (!done.some((d) => d.providerProfileId === b.providerProfileId)) {
      throw new ApiError(409, "not_completed", "You can review a provider once they have completed work in this project");
    }
    let row;
    try {
      [row] = await tx.insert(reviews).values({
        projectId, reviewerUserId: userId, providerProfileId: b.providerProfileId,
        workmanship: b.workmanship ?? null, punctuality: b.punctuality ?? null, communication: b.communication ?? null,
        professionalism: b.professionalism ?? null, quoteAccuracy: b.quoteAccuracy ?? null, comment: b.comment ?? null,
      }).returning({ id: reviews.id, createdAt: reviews.createdAt });
    } catch (e) {
      if (pgErrorCode(e) === "23505") throw new ApiError(409, "already_reviewed", "You already reviewed this provider for this project");
      throw e;
    }
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: "review.created", subjectType: "project", subjectId: projectId, payload: { providerProfileId: b.providerProfileId } });
    const [prov] = await tx.select({ userId: providerProfiles.userId }).from(providerProfiles).where(eq(providerProfiles.id, b.providerProfileId)).limit(1);
    if (prov) await notify(tx, [prov.userId], "review.received", { projectId }, userId);
    return { status: 201, body: { review: row } };
  });
});

export const providerReviewRoutes = new Hono<AuthEnv>();
providerReviewRoutes.use("*", requireAuth);

providerReviewRoutes.get("/:id/reviews", async (c) => {
  const id = uuidParam(c.req.param("id"));
  const [prov] = await db.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.id, id)).limit(1);
  if (!prov) throw new ApiError(404, "not_found", "Not found");
  const [agg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      workmanship: sql<number | null>`round(avg(${reviews.workmanship})::numeric, 2)::float`,
      punctuality: sql<number | null>`round(avg(${reviews.punctuality})::numeric, 2)::float`,
      communication: sql<number | null>`round(avg(${reviews.communication})::numeric, 2)::float`,
      professionalism: sql<number | null>`round(avg(${reviews.professionalism})::numeric, 2)::float`,
      quoteAccuracy: sql<number | null>`round(avg(${reviews.quoteAccuracy})::numeric, 2)::float`,
    })
    .from(reviews).where(eq(reviews.providerProfileId, id));
  const recent = await db
    .select({ comment: reviews.comment, workmanship: reviews.workmanship, punctuality: reviews.punctuality, communication: reviews.communication, professionalism: reviews.professionalism, quoteAccuracy: reviews.quoteAccuracy, createdAt: reviews.createdAt })
    .from(reviews).where(and(eq(reviews.providerProfileId, id), sql`${reviews.comment} is not null`))
    .orderBy(desc(reviews.createdAt)).limit(10);
  const { count, ...averages } = agg ?? { count: 0 };
  return c.json({ count, averages, recent });
});
