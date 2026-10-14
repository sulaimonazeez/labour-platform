import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import {
  languages, marketCurrencies, markets, projectBudgets, projectMembers, projects,
  requestPath, requests, serviceCategories, stages, tasks, users,
} from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { requireOrgMember } from "../authz/organisations";
import { recordActivity } from "../lib/activity";
import { runIdempotent } from "../lib/idempotency";
import { ApiError, isIanaTimezone, parseOrThrow, readJson, uuidParam } from "./http";

// Requests (PRD §3-4, §95). A request is what a person needs done; converting it creates the project.
// Visibility today: the requester only. Provider/candidate visibility arrives with matching (Phase 4).

const DEFAULT_STAGE_NAME = "Main"; // user-editable data, not a translation key
const CONVERTIBLE = ["draft", "open", "matched"] as const;

const requestCols = {
  id: requests.id,
  requesterUserId: requests.requesterUserId,
  organisationId: requests.organisationId,
  marketId: requests.marketId,
  categoryId: requests.categoryId,
  rawText: requests.rawText,
  originalLanguage: requests.originalLanguage,
  path: requests.path,
  status: requests.status,
  siteLocation: requests.siteLocation,
  createdAt: requests.createdAt,
  updatedAt: requests.updatedAt,
};

const createBody = z
  .strictObject({
    marketCode: z.string().trim().min(1).max(20).optional(),
    categoryKey: z.string().trim().min(1).max(120).optional(),
    rawText: z.string().trim().min(1).max(5000).optional(),
    originalLanguage: z.string().trim().min(2).max(20).optional(),
    path: z.enum(requestPath.enumValues).optional(),
    organisationId: z.uuid().optional(),
    siteLocation: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["draft", "open"]).optional(),
  })
  .refine((b) => b.rawText !== undefined || b.categoryKey !== undefined, {
    message: "Provide rawText or categoryKey",
    path: ["rawText"],
  });

const convertBody = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(1).max(5000).optional(),
  // Explicit on purpose (PRD §45): never inferred from location. Must be enabled for the request's market.
  currency: z.string().trim().toUpperCase().length(3),
  timezone: z.string().trim().refine(isIanaTimezone, "Unknown IANA timezone").optional(),
});

function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > 80 ? `${chars.slice(0, 79).join("").trimEnd()}…` : flat;
}

export const requestRoutes = new Hono<AuthEnv>();
requestRoutes.use("*", requireAuth);

requestRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(createBody, raw);

  return runIdempotent(c, { scope: "requests.create", userId, body: raw }, async (tx) => {
    const [me] = await tx
      .select({ marketId: users.marketId, preferredLanguage: users.preferredLanguage })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!me) throw new ApiError(401, "unauthorized", "Missing or invalid credentials");

    // Market: explicit code, else the user's own market. No guessing from anything else.
    let market: { id: string; isActive: boolean } | undefined;
    if (b.marketCode) {
      [market] = await tx.select({ id: markets.id, isActive: markets.isActive }).from(markets).where(eq(markets.code, b.marketCode)).limit(1);
      if (!market) throw new ApiError(400, "unknown_market", "Unknown market code");
    } else if (me.marketId) {
      [market] = await tx.select({ id: markets.id, isActive: markets.isActive }).from(markets).where(eq(markets.id, me.marketId)).limit(1);
    }
    if (!market) throw new ApiError(400, "market_required", "marketCode is required because your account has no market");
    if (!market.isActive) throw new ApiError(400, "market_inactive", "This market is not open yet");

    const lang = b.originalLanguage ?? me.preferredLanguage;
    const [l] = await tx
      .select({ code: languages.code })
      .from(languages)
      .where(and(eq(languages.code, lang), eq(languages.isActive, true)))
      .limit(1);
    if (!l) throw new ApiError(400, "unknown_language", "Unsupported originalLanguage");

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

    if (b.organisationId) await requireOrgMember(tx, b.organisationId, userId);

    const [row] = await tx
      .insert(requests)
      .values({
        requesterUserId: userId,
        organisationId: b.organisationId ?? null,
        marketId: market.id,
        categoryId,
        rawText: b.rawText ?? null,
        originalLanguage: l.code,
        path: b.path ?? "quick_service",
        status: b.status ?? "open",
        siteLocation: b.siteLocation ?? null,
      })
      .returning(requestCols);

    await recordActivity(tx, {
      actorUserId: userId,
      eventType: "request.created",
      subjectType: "request",
      subjectId: row.id,
      payload: { status: row.status, path: row.path, categoryId },
    });

    return { status: 201, body: { request: row } };
  });
});

requestRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const rows = await db
    .select(requestCols)
    .from(requests)
    .where(eq(requests.requesterUserId, userId))
    .orderBy(desc(requests.createdAt))
    .limit(50);
  return c.json({ requests: rows });
});

requestRoutes.get("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  // Ownership is part of the query: someone else's request is indistinguishable from a missing one.
  const [row] = await db
    .select(requestCols)
    .from(requests)
    .where(and(eq(requests.id, id), eq(requests.requesterUserId, userId)))
    .limit(1);
  if (!row) throw new ApiError(404, "not_found", "Not found");
  return c.json({ request: row });
});

// Creates, atomically: project + owner membership + default stage + first task + budget row,
// and marks the request converted. The project starts as `draft` (nothing is operational until scope is accepted, PRD §19).
requestRoutes.post("/:id/convert", async (c) => {
  const userId = c.get("auth").userId;
  const requestId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(convertBody, raw);

  return runIdempotent(c, { scope: "requests.convert", userId, body: raw }, async (tx) => {
    // Row lock: two concurrent converts with different keys serialise; the loser sees "converted" and gets 409.
    const [r] = await tx
      .select({
        id: requests.id,
        organisationId: requests.organisationId,
        marketId: requests.marketId,
        categoryId: requests.categoryId,
        rawText: requests.rawText,
        status: requests.status,
      })
      .from(requests)
      .where(and(eq(requests.id, requestId), eq(requests.requesterUserId, userId)))
      .limit(1)
      .for("update");
    if (!r) throw new ApiError(404, "not_found", "Not found");
    if (r.status === "converted") throw new ApiError(409, "already_converted", "This request has already been converted to a project");
    if (!(CONVERTIBLE as readonly string[]).includes(r.status)) {
      throw new ApiError(409, "request_not_convertible", `A ${r.status} request cannot be converted`);
    }

    const [cur] = await tx
      .select({ code: marketCurrencies.currencyCode })
      .from(marketCurrencies)
      .where(and(eq(marketCurrencies.marketId, r.marketId), eq(marketCurrencies.currencyCode, b.currency)))
      .limit(1);
    if (!cur) throw new ApiError(400, "currency_not_allowed", "This currency is not enabled for the request's market");

    const title = b.title ?? (r.rawText ? titleFrom(r.rawText) : null);
    if (!title) throw new ApiError(400, "title_required", "title is required because the request has no text");

    let timezone = b.timezone;
    if (!timezone) {
      const [me] = await tx.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
      timezone = me?.timezone;
    }
    if (!timezone) throw new ApiError(400, "timezone_required", "timezone is required");

    const [p] = await tx
      .insert(projects)
      .values({
        ownerUserId: userId,
        organisationId: r.organisationId,
        requestId: r.id,
        marketId: r.marketId,
        title,
        objective: b.objective ?? null,
        currency: b.currency,
        timezone,
      })
      .returning({
        id: projects.id, title: projects.title, objective: projects.objective, status: projects.status,
        health: projects.health, currency: projects.currency, timezone: projects.timezone,
        marketId: projects.marketId, requestId: projects.requestId, createdAt: projects.createdAt,
      });

    await tx.insert(projectMembers).values({ projectId: p.id, userId, role: "project_owner" });
    const [s] = await tx.insert(stages).values({ projectId: p.id, name: DEFAULT_STAGE_NAME, position: 0 }).returning({ id: stages.id });
    const [t] = await tx
      .insert(tasks)
      .values({ projectId: p.id, stageId: s.id, categoryId: r.categoryId, title, description: r.rawText, position: 0 })
      .returning({ id: tasks.id });
    await tx.insert(projectBudgets).values({ projectId: p.id, currency: b.currency });
    await tx.update(requests).set({ status: "converted" }).where(eq(requests.id, r.id));

    await recordActivity(tx, {
      projectId: p.id,
      actorUserId: userId,
      eventType: "request.converted",
      subjectType: "request",
      subjectId: r.id,
      payload: { projectId: p.id },
    });
    await recordActivity(tx, {
      projectId: p.id,
      actorUserId: userId,
      eventType: "project.created",
      subjectType: "project",
      subjectId: p.id,
      payload: { requestId: r.id, stageId: s.id, taskId: t.id, currency: b.currency },
    });

    return { status: 201, body: { project: p, stageId: s.id, taskId: t.id, requestId: r.id } };
  });
});
