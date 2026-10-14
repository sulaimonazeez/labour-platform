import { desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { projects, providerProfiles, providerServices, quotes, serviceCategories, taskInvitations, tasks, users } from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { recordActivity } from "../lib/activity";
import { runIdempotent } from "../lib/idempotency";
import { ApiError, parseOrThrow, pgErrorCode, readJson } from "./http";

// Provider profile (PRD §87) and the provider's own inbox of invitations (PRD §95, §142).
// Minimal on purpose: services, skills, verification and approximate location come later.

const profileCols = {
  id: providerProfiles.id,
  userId: providerProfiles.userId,
  kind: providerProfiles.kind,
  displayName: providerProfiles.displayName,
  headline: providerProfiles.headline,
  bio: providerProfiles.bio,
  remoteOk: providerProfiles.remoteOk,
  isActive: providerProfiles.isActive,
  createdAt: providerProfiles.createdAt,
};

const createBody = z.strictObject({
  displayName: z.string().trim().min(1).max(120).optional(), // default: the user's display name
  kind: z.enum(["individual", "company"]).optional(), // "team" needs the teams feature (PRD §12)
  headline: z.string().trim().min(1).max(200).optional(),
  bio: z.string().trim().min(1).max(3000).optional(),
  remoteOk: z.boolean().optional(),
});

export const providerRoutes = new Hono<AuthEnv>();
providerRoutes.use("*", requireAuth);

providerRoutes.post("/me", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(createBody, raw);

  return runIdempotent(c, { scope: "providers.create_profile", userId, body: raw }, async (tx) => {
    const [existing] = await tx.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
    if (existing) throw new ApiError(409, "provider_profile_exists", "You already have a provider profile");
    const [me] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
    if (!me) throw new ApiError(401, "unauthorized", "Missing or invalid credentials");

    let row;
    try {
      [row] = await tx
        .insert(providerProfiles)
        .values({
          userId,
          kind: b.kind ?? "individual",
          displayName: b.displayName ?? me.displayName,
          headline: b.headline ?? null,
          bio: b.bio ?? null,
          remoteOk: b.remoteOk ?? false,
        })
        .returning(profileCols);
    } catch (e) {
      // Two concurrent creates with DIFFERENT idempotency keys: the unique(user_id) index decides.
      if (pgErrorCode(e) === "23505") throw new ApiError(409, "provider_profile_exists", "You already have a provider profile");
      throw e;
    }
    await recordActivity(tx, {
      actorUserId: userId,
      eventType: "provider.profile_created",
      subjectType: "provider_profile",
      subjectId: row.id,
      payload: { kind: row.kind },
    });
    return { status: 201, body: { provider: row } };
  });
});

providerRoutes.get("/me", async (c) => {
  const userId = c.get("auth").userId;
  const [row] = await db.select(profileCols).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
  if (!row) throw new ApiError(404, "no_provider_profile", "You do not have a provider profile");
  return c.json({ provider: row });
});

// The provider's inbox: tasks they were invited to quote on. Deliberately NOT the project view:
// a provider sees the brief of the task and nothing else about the project (PRD §34, §40).
providerRoutes.get("/me/invitations", async (c) => {
  const userId = c.get("auth").userId;
  const [profile] = await db.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
  if (!profile) throw new ApiError(404, "no_provider_profile", "You do not have a provider profile");

  const rows = await db
    .select({
      taskId: tasks.id,
      taskTitle: tasks.title,
      taskDescription: tasks.description,
      taskStatus: tasks.status,
      materialResponsibility: tasks.materialResponsibility,
      projectTitle: projects.title,
      projectCurrency: projects.currency,
      projectTimezone: projects.timezone,
      status: taskInvitations.status,
      invitedAt: taskInvitations.createdAt,
    })
    .from(taskInvitations)
    .innerJoin(tasks, eq(tasks.id, taskInvitations.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(taskInvitations.providerProfileId, profile.id))
    .orderBy(desc(taskInvitations.createdAt));

  const myQuotes = await db
    .select({ id: quotes.id, taskId: quotes.taskId, status: quotes.status, createdAt: quotes.createdAt })
    .from(quotes)
    .where(eq(quotes.providerProfileId, profile.id))
    .orderBy(desc(quotes.createdAt));

  const invitations = rows.map((r) => {
    // Latest quote of mine on this task (newest first above).
    const q = myQuotes.find((x) => x.taskId === r.taskId);
    return { ...r, quoteId: q?.id ?? null, quoteStatus: q?.status ?? null };
  });
  return c.json({ invitations });
});

// The trades a provider offers (PRD §24, §87). Identity is the canonical key; the list REPLACES the previous one.
const servicesBody = z.strictObject({ categories: z.array(z.string().trim().min(1).max(100)).max(20) });

providerRoutes.get("/me/services", async (c) => {
  const userId = c.get("auth").userId;
  const [profile] = await db.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
  if (!profile) throw new ApiError(404, "no_provider_profile", "You do not have a provider profile");
  const rows = await db
    .select({ key: serviceCategories.canonicalKey })
    .from(providerServices)
    .innerJoin(serviceCategories, eq(serviceCategories.id, providerServices.categoryId))
    .where(eq(providerServices.providerProfileId, profile.id));
  return c.json({ categories: rows.map((r) => r.key) });
});

providerRoutes.put("/me/services", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(servicesBody, raw);
  const keys = [...new Set(b.categories)];

  return runIdempotent(c, { scope: "providers.set_services", userId, body: raw }, async (tx) => {
    const [profile] = await tx.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
    if (!profile) throw new ApiError(404, "no_provider_profile", "You do not have a provider profile");

    const cats = keys.length === 0 ? [] : await tx
      .select({ id: serviceCategories.id, key: serviceCategories.canonicalKey })
      .from(serviceCategories)
      .where(inArray(serviceCategories.canonicalKey, keys));
    const known = new Set(cats.map((x) => x.key));
    const unknown = keys.filter((k) => !known.has(k));
    if (unknown.length > 0) throw new ApiError(400, "unknown_category", "Some services are not in the taxonomy", { unknown });

    await tx.delete(providerServices).where(eq(providerServices.providerProfileId, profile.id));
    if (cats.length > 0) await tx.insert(providerServices).values(cats.map((x) => ({ providerProfileId: profile.id, categoryId: x.id })));
    await recordActivity(tx, {
      actorUserId: userId,
      eventType: "provider.services_set",
      subjectType: "provider_profile",
      subjectId: profile.id,
      payload: { categories: keys },
    });
    return { status: 200, body: { categories: keys } };
  });
});
