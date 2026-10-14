import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import {
  assignments, featureFlags, languages, projectTemplates, projects, promotedListings, providerAvailability, providerProfiles,
  markets, providerServices, reviews, serviceCategories, tasks, templateVersions, users, verifications,
} from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { isPlatformAdmin, requirePlatformAdmin } from "../authz/platform-admin";
import { classifyAgainst, loadCatalog, type Classification } from "../ai/rules";
import { extractJson, runAi } from "../ai/govern";
import { AiUnavailable } from "../ai/providers";
import { isFeatureOn } from "../lib/flags";
import { runIdempotent } from "../lib/idempotency";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http";

// PRD §24 (database-driven taxonomy), §36-38 (discovery by problem, explainable ranking), §96-97 (fair ranking, labelled
// promotion), §22-23 (template library with versions), §151 (feature flags).

const lang = (c: { req: { query: (k: string) => string | undefined } }, fallback = "en") => c.req.query("lang")?.trim() || fallback;

// ── categories ───────────────────────────────────────────────────────────────
export const categoryRoutes = new Hono<AuthEnv>();
categoryRoutes.use("*", requireAuth);
categoryRoutes.get("/", async (c) => {
  const l = lang(c);
  const cats = await loadCatalog(db, l);
  return c.json({ language: l, categories: cats });
});

// ── classification ───────────────────────────────────────────────────────────
export const discoverRoutes = new Hono<AuthEnv>();
discoverRoutes.use("*", requireAuth);

const classifyBody = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  language: z.string().trim().min(2).max(12).optional(),
  useAi: z.boolean().optional(),
});

discoverRoutes.post("/classify", async (c) => {
  const userId = c.get("auth").userId;
  const b = parseOrThrow(classifyBody, await readJson(c));
  const [me] = await db.select({ lang: users.preferredLanguage }).from(users).where(eq(users.id, userId)).limit(1);
  const l = b.language ?? me?.lang ?? "en";
  const catalog = await loadCatalog(db, l);
  let result: Classification = classifyAgainst(catalog, b.text);
  // Optional AI second opinion, only when rules are unsure. It may only choose from the real catalogue (PRD §20).
  if (b.useAi && !result.confident && catalog.length > 0) {
    try {
      const out = await runAi(db, {
        userId, purpose: "classify", maxTokens: 200,
        system: "Pick the single best service category key for the customer's need from the list. Reply with JSON only: {\"key\": string|null}. Use null if none fits.",
        prompt: `Need: ${b.text}\nCategories: ${catalog.map((x) => `${x.key} (${x.name})`).join("; ")}`,
        context: { fallback: { key: result.topKey } },
      });
      const key = (extractJson(out.text) as { key?: unknown } | null)?.key;
      const hit = typeof key === "string" ? catalog.find((x) => x.key === key) : undefined;
      if (hit) result = { ...result, topKey: hit.key, matches: [{ key: hit.key, name: hit.name, risk: hit.risk, score: 99 }, ...result.matches.filter((m) => m.key !== hit.key)].slice(0, 3), confident: true };
    } catch (e) {
      if (!(e instanceof AiUnavailable)) throw e;
    }
  }
  return c.json({ classification: result });
});

// ── explainable provider ranking (PRD §38, §94, §96, §97) ────────────────────
const rad = (d: number) => (d * Math.PI) / 180;
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const rankQuery = z.object({
  category: z.string().trim().max(120).optional(),
  q: z.string().trim().max(100).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

discoverRoutes.get("/providers", async (c) => {
  const userId = c.get("auth").userId;
  const q = parseOrThrow(rankQuery, Object.fromEntries(new URL(c.req.url).searchParams));
  const [me] = await db.select({ lang: users.preferredLanguage, secondary: users.secondaryLanguages, marketId: users.marketId }).from(users).where(eq(users.id, userId)).limit(1);
  const myLangs = new Set([me?.lang ?? "en", ...(me?.secondary ?? [])]);

  let categoryId: string | null = null;
  let required: string[] = [];
  if (q.category) {
    const [cat] = await db.select().from(serviceCategories).where(eq(serviceCategories.canonicalKey, q.category)).limit(1);
    if (!cat) throw new ApiError(400, "unknown_category", "That service category does not exist");
    categoryId = cat.id;
    required = cat.requiredCredentials ?? [];
  }

  const base = await db
    .select({ p: providerProfiles, lang: users.preferredLanguage, secondary: users.secondaryLanguages })
    .from(providerProfiles)
    .innerJoin(users, eq(users.id, providerProfiles.userId))
    .where(and(eq(providerProfiles.isActive, true), sql`${providerProfiles.userId} <> ${userId}`))
    .limit(500);
  let candidates = base;
  if (categoryId) {
    const offered = new Set((await db.select({ id: providerServices.providerProfileId }).from(providerServices).where(eq(providerServices.categoryId, categoryId))).map((r) => r.id));
    candidates = candidates.filter((r) => offered.has(r.p.id));
  }
  if (q.q) {
    const needle = q.q.toLowerCase();
    candidates = candidates.filter((r) => `${r.p.displayName} ${r.p.headline ?? ""}`.toLowerCase().includes(needle));
  }
  const ids = candidates.map((r) => r.p.id);
  if (ids.length === 0) return c.json({ sponsored: [], results: [], excluded: { count: 0, reasons: {} } });
  const userIds = candidates.map((r) => r.p.userId);

  const asg = await db.select({ pid: assignments.providerProfileId, status: assignments.status, n: sql<number>`count(*)::int` })
    .from(assignments).where(inArray(assignments.providerProfileId, ids)).groupBy(assignments.providerProfileId, assignments.status);
  const rev = await db.select({
    pid: reviews.providerProfileId, n: sql<number>`count(*)::int`,
    avg: sql<string | null>`avg((coalesce(${reviews.workmanship},0)+coalesce(${reviews.punctuality},0)+coalesce(${reviews.communication},0)+coalesce(${reviews.professionalism},0)+coalesce(${reviews.quoteAccuracy},0))::numeric / nullif((${reviews.workmanship} is not null)::int+(${reviews.punctuality} is not null)::int+(${reviews.communication} is not null)::int+(${reviews.professionalism} is not null)::int+(${reviews.quoteAccuracy} is not null)::int,0))`,
  }).from(reviews).where(inArray(reviews.providerProfileId, ids)).groupBy(reviews.providerProfileId);
  const ver = await db.select({ uid: verifications.userId, cls: verifications.verificationClass })
    .from(verifications)
    .where(and(inArray(verifications.userId, userIds), eq(verifications.status, "verified"), or(isNull(verifications.expiresAt), sql`${verifications.expiresAt} >= current_date`)));
  const avail = new Set((await db.select({ pid: providerAvailability.providerProfileId }).from(providerAvailability).where(inArray(providerAvailability.providerProfileId, ids))).map((r) => r.pid));
  const repeat = new Set((await db.select({ pid: assignments.providerProfileId }).from(assignments)
    .innerJoin(tasks, eq(tasks.id, assignments.taskId)).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(projects.ownerUserId, userId), eq(assignments.status, "completed"), inArray(assignments.providerProfileId, ids)))).map((r) => r.pid));
  const promo = q.category
    ? new Set((await db.select({ pid: promotedListings.providerProfileId }).from(promotedListings)
      .where(and(eq(promotedListings.categoryKey, q.category), sql`${promotedListings.startsAt} <= now()`, sql`${promotedListings.endsAt} > now()`, or(isNull(promotedListings.marketId), me?.marketId ? eq(promotedListings.marketId, me.marketId) : sql`false`)))).map((r) => r.pid))
    : new Set<string>();

  const origin = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : null;
  const excluded: Record<string, number> = {};
  const skip = (why: string) => { excluded[why] = (excluded[why] ?? 0) + 1; };

  type Ranked = { providerId: string; displayName: string; headline: string | null; kind: string; remoteOk: boolean; score: number; sponsored: boolean; distanceKm: number | null; reasons: string[]; breakdown: Record<string, number> };
  const ranked: Ranked[] = [];
  for (const r of candidates) {
    const p = r.p;
    const held = new Set(ver.filter((v) => v.uid === p.userId).map((v) => v.cls as string));
    if (required.length > 0 && !required.every((x) => held.has(x))) { skip("missing_required_credentials"); continue; }
    let dist: number | null = null;
    if (origin && p.approxLat !== null && p.approxLng !== null) {
      dist = haversineKm(origin, { lat: Number(p.approxLat), lng: Number(p.approxLng) });
      if (p.serviceRadiusKm !== null && dist > p.serviceRadiusKm && !p.remoteOk) { skip("outside_service_area"); continue; }
    }
    const mine = asg.filter((a) => a.pid === p.id);
    const done = mine.find((a) => a.status === "completed")?.n ?? 0;
    const bad = mine.filter((a) => ["rejected", "withdrawn", "cancelled"].includes(a.status)).reduce((n, a) => n + a.n, 0);
    const rate = done + bad > 0 ? done / (done + bad) : null;
    const rv = rev.find((x) => x.pid === p.id);
    const rating = rv && rv.avg !== null ? Number(rv.avg) : null;
    const shared = myLangs.has(r.lang) || (r.secondary ?? []).some((x) => myLangs.has(x));

    const reasons: string[] = [];
    const br: Record<string, number> = {};
    br.fit = categoryId ? 25 : 12; reasons.push(categoryId ? "Offers this service" : "Matches your search");
    br.distance = dist === null ? 10 : Math.round(20 * Math.max(0, 1 - dist / Math.max(1, p.serviceRadiusKm ?? 50)));
    reasons.push(dist === null ? "Distance unknown" : `${dist.toFixed(1)} km away`);
    br.reliability = rate === null ? 10 : Math.round(20 * rate);
    reasons.push(rate === null ? "No finished jobs yet" : `${Math.round(rate * 100)}% of jobs completed`);
    br.quality = rating === null ? 10 : Math.round((rating / 5) * 20);
    reasons.push(rating === null ? "No reviews yet" : `${rating.toFixed(1)} / 5 across ${rv?.n} review(s)`);
    br.verification = Math.round((Math.min(3, held.size) / 3) * 10);
    if (held.size > 0) reasons.push(`${held.size} verified credential(s)`);
    br.language = shared ? 5 : 0; if (shared) reasons.push("Speaks your language");
    br.repeat = repeat.has(p.id) ? 5 : 0; if (repeat.has(p.id)) reasons.push("You have hired them before");
    br.newcomer = done < 3 ? 8 - done * 2 : 0; if (done < 3) reasons.push("New on the platform: given a fair start");
    br.availability = avail.has(p.id) ? 3 : 0; if (avail.has(p.id)) reasons.push("Has published availability");
    const score = Math.min(100, Object.values(br).reduce((n, v) => n + v, 0));
    ranked.push({ providerId: p.id, displayName: p.displayName, headline: p.headline, kind: p.kind, remoteOk: p.remoteOk, score, sponsored: promo.has(p.id), distanceKm: dist === null ? null : Math.round(dist * 10) / 10, reasons, breakdown: br });
  }
  ranked.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
  const sponsored = ranked.filter((r) => r.sponsored).slice(0, 2);
  const results = ranked.filter((r) => !sponsored.includes(r)).slice(0, q.limit);
  return c.json({ sponsored, results, excluded: { count: Object.values(excluded).reduce((n, v) => n + v, 0), reasons: excluded }, note: "Sponsored results are labelled and only ever come from providers who already qualify." });
});

// ── template library (PRD §22-23) ────────────────────────────────────────────
export const templateRoutes = new Hono<AuthEnv>();
templateRoutes.use("*", requireAuth);

templateRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const cat = c.req.query("category");
  const rows = await db
    .select({ t: projectTemplates, v: templateVersions })
    .from(projectTemplates)
    .innerJoin(templateVersions, eq(templateVersions.templateId, projectTemplates.id))
    .where(and(
      cat ? eq(projectTemplates.categoryKey, cat) : sql`true`,
      or(and(eq(projectTemplates.visibility, "global"), eq(templateVersions.approvalState, "approved")), eq(projectTemplates.ownerUserId, userId)),
    ))
    .orderBy(desc(templateVersions.version));
  return c.json({
    templates: rows.map((r) => ({
      key: r.t.key, title: r.t.title, description: r.t.description, categoryKey: r.t.categoryKey, ownerKind: r.t.ownerKind, visibility: r.t.visibility,
      version: r.v.version, language: r.v.language, approvalState: r.v.approvalState, sourceKind: r.v.sourceKind, marketCodes: r.v.marketCodes,
      regulations: r.v.regulations, effectiveFrom: r.v.effectiveFrom, mine: r.t.ownerUserId === userId,
    })),
  });
});

const bodySchema = z.record(z.string(), z.unknown());
const createTemplateBody = z.strictObject({
  key: z.string().trim().regex(/^[a-z0-9_]{3,80}$/),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  categoryKey: z.string().trim().max(120).optional(),
  language: z.string().trim().min(2).max(12).default("en"),
  body: bodySchema,
  sourceKind: z.enum(["platform", "verified_expert", "professional_body", "business", "government", "programme", "approved_project", "ai_validated"]).default("business"),
  marketCodes: z.array(z.string().trim().max(10)).max(50).default([]),
  regulations: z.array(z.string().trim().max(120)).max(20).default([]),
  effectiveFrom: z.iso.date().optional(),
});

templateRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(createTemplateBody, raw);
  return runIdempotent(c, { scope: "templates.create", userId, body: raw }, async (tx) => {
    const [exists] = await tx.select({ id: projectTemplates.id }).from(projectTemplates).where(eq(projectTemplates.key, b.key)).limit(1);
    if (exists) throw new ApiError(409, "template_exists", "A template with this key already exists");
    const [t] = await tx.insert(projectTemplates).values({
      key: b.key, title: b.title, description: b.description ?? null, categoryKey: b.categoryKey ?? null, ownerKind: isPlatformAdmin(userId) ? "platform" : "private",
      ownerUserId: userId, visibility: isPlatformAdmin(userId) ? "global" : "private",
    }).returning({ id: projectTemplates.id });
    const [v] = await tx.insert(templateVersions).values({
      templateId: t.id, version: 1, language: b.language, body: b.body, sourceKind: b.sourceKind, authorUserId: userId, marketCodes: b.marketCodes,
      regulations: b.regulations, effectiveFrom: b.effectiveFrom ?? null,
    }).returning({ id: templateVersions.id });
    return { status: 201, body: { template: { id: t.id, key: b.key, versionId: v.id, version: 1, approvalState: "draft" } } };
  });
});

const newVersionBody = z.strictObject({
  language: z.string().trim().min(2).max(12).default("en"),
  body: bodySchema,
  marketCodes: z.array(z.string().trim().max(10)).max(50).default([]),
  regulations: z.array(z.string().trim().max(120)).max(20).default([]),
  effectiveFrom: z.iso.date().optional(),
});

templateRoutes.post("/:key/versions", async (c) => {
  const userId = c.get("auth").userId;
  const key = c.req.param("key");
  const raw = await readJson(c);
  const b = parseOrThrow(newVersionBody, raw);
  return runIdempotent(c, { scope: "templates.version", userId, body: { key, raw } }, async (tx) => {
    const [t] = await tx.select().from(projectTemplates).where(eq(projectTemplates.key, key)).limit(1).for("update");
    if (!t || (t.ownerUserId !== userId && !isPlatformAdmin(userId))) throw new ApiError(404, "not_found", "Not found");
    const [last] = await tx.select({ v: templateVersions.version }).from(templateVersions).where(eq(templateVersions.templateId, t.id)).orderBy(desc(templateVersions.version)).limit(1);
    const version = (last?.v ?? 0) + 1;
    const [v] = await tx.insert(templateVersions).values({
      templateId: t.id, version, language: b.language, body: b.body, sourceKind: "business", authorUserId: userId,
      marketCodes: b.marketCodes, regulations: b.regulations, effectiveFrom: b.effectiveFrom ?? null,
    }).returning({ id: templateVersions.id });
    return { status: 201, body: { version: { id: v.id, version, approvalState: "draft" } } };
  });
});

templateRoutes.post("/:key/versions/:version/submit", async (c) => {
  const userId = c.get("auth").userId;
  const key = c.req.param("key");
  const version = Number(c.req.param("version"));
  if (!Number.isInteger(version)) throw new ApiError(404, "not_found", "Not found");
  return runIdempotent(c, { scope: "templates.submit", userId, body: { key, version } }, async (tx) => {
    const [t] = await tx.select().from(projectTemplates).where(eq(projectTemplates.key, key)).limit(1);
    if (!t || (t.ownerUserId !== userId && !isPlatformAdmin(userId))) throw new ApiError(404, "not_found", "Not found");
    const r = await tx.update(templateVersions).set({ approvalState: "in_review" })
      .where(and(eq(templateVersions.templateId, t.id), eq(templateVersions.version, version), eq(templateVersions.approvalState, "draft"))).returning({ id: templateVersions.id });
    if (r.length === 0) throw new ApiError(409, "not_draft", "Only a draft version can be submitted for review");
    return { status: 200, body: { version, approvalState: "in_review" } };
  });
});

const decideBody = z.strictObject({ decision: z.enum(["approved", "rejected"]), global: z.boolean().optional() });
templateRoutes.post("/:key/versions/:version/decide", async (c) => {
  const userId = c.get("auth").userId;
  requirePlatformAdmin(userId);
  const key = c.req.param("key");
  const version = Number(c.req.param("version"));
  const raw = await readJson(c);
  const b = parseOrThrow(decideBody, raw);
  if (!Number.isInteger(version)) throw new ApiError(404, "not_found", "Not found");
  return runIdempotent(c, { scope: "templates.decide", userId, body: { key, version, raw } }, async (tx) => {
    const [t] = await tx.select().from(projectTemplates).where(eq(projectTemplates.key, key)).limit(1).for("update");
    if (!t) throw new ApiError(404, "not_found", "Not found");
    const [v] = await tx.select().from(templateVersions).where(and(eq(templateVersions.templateId, t.id), eq(templateVersions.version, version))).limit(1);
    if (!v) throw new ApiError(404, "not_found", "Not found");
    if (v.approvalState !== "in_review" && v.approvalState !== "draft") throw new ApiError(409, "not_reviewable", `A ${v.approvalState} version cannot be decided`);
    await tx.update(templateVersions).set({ approvalState: b.decision, approvedByUserId: userId, approvedAt: new Date() }).where(eq(templateVersions.id, v.id));
    if (b.decision === "approved") {
      // PRD §23: the previous approved version is marked superseded; projects keep the version they were created with.
      await tx.update(templateVersions).set({ approvalState: "superseded", supersededByVersionId: v.id })
        .where(and(eq(templateVersions.templateId, t.id), eq(templateVersions.approvalState, "approved"), sql`${templateVersions.id} <> ${v.id}`, eq(templateVersions.language, v.language)));
      if (b.global) await tx.update(projectTemplates).set({ visibility: "global" }).where(eq(projectTemplates.id, t.id));
    }
    return { status: 200, body: { version, approvalState: b.decision } };
  });
});

// ── feature flags (PRD §151) ─────────────────────────────────────────────────
export const flagRoutes = new Hono<AuthEnv>();
flagRoutes.use("*", requireAuth);
flagRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const [me] = await db.select({ code: markets.code }).from(users).leftJoin(markets, eq(markets.id, users.marketId)).where(eq(users.id, userId)).limit(1);
  const rows = await db.select().from(featureFlags);
  const out: Record<string, boolean> = {};
  for (const f of rows) out[f.key] = await isFeatureOn(db, f.key, { userId, marketCode: me?.code ?? undefined });
  return c.json({ flags: out });
});

// Languages a person can pick (PRD §26). Native and English names so the list is readable in any script.
export const languageRoutes = new Hono<AuthEnv>();
languageRoutes.use("*", requireAuth);
languageRoutes.get("/", async (c) => {
  const rows = await db.select({ code: languages.code, nameNative: languages.nameNative, nameEnglish: languages.nameEnglish, direction: languages.direction }).from(languages).where(eq(languages.isActive, true));
  return c.json({ languages: rows });
});
