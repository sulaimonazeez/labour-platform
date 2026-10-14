import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  aiInteractions, aiUsageDaily, assignments, currencies, disputes, featureFlags, idempotencyKeys, insuranceRecords, languages, marketComplianceSettings, marketCurrencies,
  marketHolidays, marketLanguages, marketPaymentMethods, marketTaxRules, marketVerificationRules, markets, moderationReports, organisationMembers, organisations,
  platformEvents, privacyRequests, programmeParticipants, programmes, projects, promotedListings, providerProfiles, providerServices, quoteVersions, quotes, rateLimitHits, recurringServices, requests,
  retentionPolicies, safetyIncidents, serviceCategories, sessions, tasks, users, verifications,
} from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { isPlatformAdmin, requirePlatformAdmin } from "../authz/platform-admin.js";
import { requireOrgMember, type OrgRole } from "../authz/organisations.js";
import { runIdempotent } from "../lib/idempotency.js";
import { logEvent } from "../lib/events.js";
import { notify } from "../lib/notify.js";
import { generateOccurrence } from "./schedule-routes.js";
import { ApiError, isIanaTimezone, parseOrThrow, readJson, uuidParam } from "./http.js";

// PRD §8, §119-122 (institutions, registries, privacy-preserving analytics), §127-131 (market configuration, retention),
// §145 (admin), §150-151 (observability, flags). Groups smaller than MIN_GROUP are never shown (PRD §121).

const MIN_GROUP = () => Math.max(2, Number(process.env.MIN_GROUP_SIZE ?? 5));
const notFound = () => new ApiError(404, "not_found", "Not found");
const INSTITUTION_ADMINS: readonly OrgRole[] = ["owner", "admin"];
const INSTITUTION_READERS: readonly OrgRole[] = ["owner", "admin", "auditor"];

// ── programmes and registries ────────────────────────────────────────────────
export const programmeRoutes = new Hono<AuthEnv>();
programmeRoutes.use("*", requireAuth);
const progBody = z.strictObject({ organisationId: z.uuid(), name: z.string().trim().min(1).max(200), region: z.string().trim().max(120).optional(), startsOn: z.iso.date().optional(), endsOn: z.iso.date().optional(), goals: z.record(z.string(), z.unknown()).default({}) });
programmeRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(progBody, raw);
  return runIdempotent(c, { scope: "programmes.create", userId, body: raw }, async (tx) => {
    await requireOrgMember(tx, b.organisationId, userId, INSTITUTION_ADMINS);
    const [p] = await tx.insert(programmes).values({ organisationId: b.organisationId, name: b.name, region: b.region ?? null, startsOn: b.startsOn ?? null, endsOn: b.endsOn ?? null, goals: b.goals }).onConflictDoNothing().returning({ id: programmes.id });
    if (!p) throw new ApiError(409, "exists", "This organisation already has a programme with that name");
    return { status: 201, body: { programme: { id: p.id, name: b.name } } };
  });
});
programmeRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const orgIds = (await db.select({ id: organisationMembers.organisationId }).from(organisationMembers).where(eq(organisationMembers.userId, userId))).map((r) => r.id);
  if (orgIds.length === 0) return c.json({ programmes: [] });
  return c.json({ programmes: await db.select().from(programmes).where(inArray(programmes.organisationId, orgIds)).orderBy(desc(programmes.createdAt)) });
});
async function programmeFor(userId: string, id: string, allowed: readonly OrgRole[]) {
  const [p] = await db.select().from(programmes).where(eq(programmes.id, id)).limit(1);
  if (!p) throw notFound();
  await requireOrgMember(db, p.organisationId, userId, allowed);
  return p;
}
const STATUSES = ["enrolled", "trained", "assessed", "verified", "listed", "working", "graduated", "withdrawn"] as const;
programmeRoutes.post("/:id/participants", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ email: z.email().max(254) }), raw);
  return runIdempotent(c, { scope: "programmes.enrol", userId, body: { id, raw } }, async (tx) => {
    const [p] = await tx.select().from(programmes).where(eq(programmes.id, id)).limit(1);
    if (!p) throw notFound();
    await requireOrgMember(tx, p.organisationId, userId, INSTITUTION_ADMINS);
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, b.email.toLowerCase())).limit(1);
    if (!u) throw new ApiError(404, "user_not_found", "No account uses that email address yet");
    await tx.insert(programmeParticipants).values({ programmeId: id, userId: u.id }).onConflictDoNothing();
    await notify(tx, [u.id], "programme.enrolled", { programmeId: id }, userId);
    return { status: 201, body: { participant: { userId: u.id, status: "enrolled" } } };
  });
});
// Personal details are for the programme's own admins and auditors only (PRD §119).
programmeRoutes.get("/:id/participants", async (c) => {
  const userId = c.get("auth").userId;
  const p = await programmeFor(userId, uuidParam(c.req.param("id")), INSTITUTION_READERS);
  const rows = await db.select({ pp: programmeParticipants, name: users.displayName, email: users.email, provider: providerProfiles.id }).from(programmeParticipants)
    .innerJoin(users, eq(users.id, programmeParticipants.userId)).leftJoin(providerProfiles, eq(providerProfiles.userId, users.id)).where(eq(programmeParticipants.programmeId, p.id)).orderBy(asc(users.displayName));
  return c.json({ participants: rows.map((r) => ({ userId: r.pp.userId, name: r.name, email: r.email, status: r.pp.status, assessment: r.pp.assessment, hasProviderProfile: !!r.provider })) });
});
programmeRoutes.post("/:id/participants/:userId/status", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const target = uuidParam(c.req.param("userId"));
  const b = parseOrThrow(z.strictObject({ status: z.enum(STATUSES), assessment: z.record(z.string(), z.unknown()).optional() }), await readJson(c));
  return runIdempotent(c, { scope: "programmes.status", userId, body: { id, target, b } }, async (tx) => {
    const [p] = await tx.select().from(programmes).where(eq(programmes.id, id)).limit(1);
    if (!p) throw notFound();
    await requireOrgMember(tx, p.organisationId, userId, INSTITUTION_ADMINS);
    const r = await tx.update(programmeParticipants).set({ status: b.status, ...(b.assessment ? { assessment: b.assessment } : {}) }).where(and(eq(programmeParticipants.programmeId, id), eq(programmeParticipants.userId, target))).returning({ u: programmeParticipants.userId });
    if (r.length === 0) throw notFound();
    return { status: 200, body: { participant: { userId: target, status: b.status } } };
  });
});
// PRD §122: outcomes, not attendance. Aggregated, with small groups suppressed.
programmeRoutes.get("/:id/outcomes", async (c) => {
  const p = await programmeFor(c.get("auth").userId, uuidParam(c.req.param("id")), INSTITUTION_READERS);
  const min = MIN_GROUP();
  const byStatus = await db.select({ status: programmeParticipants.status, n: sql<number>`count(*)::int` }).from(programmeParticipants).where(eq(programmeParticipants.programmeId, p.id)).groupBy(programmeParticipants.status);
  const total = byStatus.reduce((n, r) => n + r.n, 0);
  const work = await db.select({ cur: quoteVersions.currency, workers: sql<number>`count(distinct ${providerProfiles.userId})::int`, jobs: sql<number>`count(*)::int`, earned: sql<number>`coalesce(sum(${quoteVersions.totalMinor}),0)::bigint` })
    .from(programmeParticipants).innerJoin(providerProfiles, eq(providerProfiles.userId, programmeParticipants.userId)).innerJoin(assignments, eq(assignments.providerProfileId, providerProfiles.id))
    .innerJoin(quotes, eq(quotes.id, assignments.quoteId)).innerJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.acceptedVersion)))
    .where(and(eq(programmeParticipants.programmeId, p.id), eq(assignments.status, "completed"))).groupBy(quoteVersions.currency);
  return c.json({
    outcomes: {
      participants: total >= min ? total : null,
      byStatus: byStatus.map((r) => ({ status: r.status, count: r.n >= min ? r.n : null })),
      completedWork: work.map((w) => (w.workers >= min ? { currency: w.cur, workers: w.workers, jobs: w.jobs, earnedMinor: Number(w.earned) } : { currency: w.cur, workers: null, jobs: null, earnedMinor: null })),
      minimumGroupSize: min,
      note: `Counts for groups smaller than ${min} are hidden to protect individuals.`,
    },
  });
});

// ── market intelligence (PRD §120-121, §161) ─────────────────────────────────
export const insightRoutes = new Hono<AuthEnv>();
insightRoutes.use("*", requireAuth);
insightRoutes.get("/market", async (c) => {
  const userId = c.get("auth").userId;
  if (!isPlatformAdmin(userId)) {
    const m = await db.select({ t: organisations.type }).from(organisationMembers).innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId)).where(eq(organisationMembers.userId, userId));
    if (!m.some((x) => ["government", "ngo", "institution", "business"].includes(x.t))) throw new ApiError(403, "forbidden", "Market insights are for organisations");
  }
  const min = MIN_GROUP();
  const since = new Date(Date.now() - 180 * 86400_000);
  const monthExpr = sql<string>`to_char(date_trunc('month', ${requests.createdAt}), 'YYYY-MM')`;
  const demand = await db.select({ key: serviceCategories.canonicalKey, month: monthExpr, n: sql<number>`count(*)::int` })
    .from(requests).innerJoin(serviceCategories, eq(serviceCategories.id, requests.categoryId)).where(gte(requests.createdAt, since)).groupBy(serviceCategories.canonicalKey, monthExpr).limit(500);
  const supply = await db.select({ key: serviceCategories.canonicalKey, n: sql<number>`count(distinct ${providerServices.providerProfileId})::int` }).from(providerServices).innerJoin(serviceCategories, eq(serviceCategories.id, providerServices.categoryId)).groupBy(serviceCategories.canonicalKey);
  const pricing = await db.select({ key: serviceCategories.canonicalKey, cur: quoteVersions.currency, n: sql<number>`count(*)::int`, median: sql<number>`percentile_cont(0.5) within group (order by ${quoteVersions.totalMinor})::bigint`, avg: sql<number>`avg(${quoteVersions.totalMinor})::bigint` })
    .from(assignments).innerJoin(tasks, eq(tasks.id, assignments.taskId)).innerJoin(serviceCategories, eq(serviceCategories.id, tasks.categoryId))
    .innerJoin(quotes, eq(quotes.id, assignments.quoteId)).innerJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.acceptedVersion)))
    .groupBy(serviceCategories.canonicalKey, quoteVersions.currency);
  const flow = await db.select({ status: assignments.status, n: sql<number>`count(*)::int` }).from(assignments).groupBy(assignments.status);
  const done = flow.find((f) => f.status === "completed")?.n ?? 0;
  const all = flow.reduce((n, f) => n + f.n, 0);
  return c.json({
    minimumGroupSize: min,
    demand: demand.filter((d) => d.n >= min),
    supply: supply.map((s) => ({ category: s.key, providers: s.n >= min ? s.n : null })),
    pricing: pricing.filter((p) => p.n >= min).map((p) => ({ category: p.key, currency: p.cur, jobs: p.n, medianMinor: Number(p.median), averageMinor: Number(p.avg) })),
    completion: all >= min ? { assignments: all, completedShare: Math.round((done / all) * 100) } : null,
    note: "Aggregated and anonymous. Groups smaller than the minimum are hidden. Prices are per currency.",
  });
});

// ── admin: config, flags, events, AI, retention, promotion, privacy ──────────
export const platformAdminRoutes = new Hono<AuthEnv>();
platformAdminRoutes.use("*", requireAuth);
platformAdminRoutes.use("*", async (c, next) => { requirePlatformAdmin(c.get("auth").userId); await next(); });

platformAdminRoutes.get("/overview", async (c) => {
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const [u, p, pr, od, oi, pv, mr, pq] = await Promise.all([
    count(db.select({ n: sql<number>`count(*)::int` }).from(users)), count(db.select({ n: sql<number>`count(*)::int` }).from(providerProfiles)),
    db.select({ s: projects.status, n: sql<number>`count(*)::int` }).from(projects).groupBy(projects.status),
    count(db.select({ n: sql<number>`count(*)::int` }).from(disputes).where(inArray(disputes.status, ["open", "awaiting_response", "in_review"]))),
    count(db.select({ n: sql<number>`count(*)::int` }).from(safetyIncidents).where(sql`${safetyIncidents.status} <> 'closed'`)),
    count(db.select({ n: sql<number>`count(*)::int` }).from(verifications).where(eq(verifications.status, "pending"))),
    count(db.select({ n: sql<number>`count(*)::int` }).from(moderationReports).where(eq(moderationReports.status, "open"))),
    count(db.select({ n: sql<number>`count(*)::int` }).from(privacyRequests).where(eq(privacyRequests.status, "received"))),
  ]);
  return c.json({ overview: { users: u, providers: p, projectsByStatus: pr, openDisputes: od, openSafetyIncidents: oi, pendingVerifications: pv, openModerationReports: mr, openPrivacyRequests: pq } });
});

platformAdminRoutes.get("/flags", async (c) => c.json({ flags: await db.select().from(featureFlags).orderBy(asc(featureFlags.key)) }));
const flagBody = z.strictObject({
  enabled: z.boolean(), description: z.string().trim().max(300).optional(),
  scope: z.strictObject({ markets: z.array(z.string().max(10)).max(100).optional(), organisations: z.array(z.uuid()).max(500).optional(), categories: z.array(z.string().max(120)).max(200).optional(), rolloutPercent: z.int().min(0).max(100).optional() }).default({}),
});
platformAdminRoutes.put("/flags/:key", async (c) => {
  const userId = c.get("auth").userId;
  const key = c.req.param("key");
  if (!/^[a-z0-9_.]{2,80}$/.test(key)) throw new ApiError(400, "invalid_key", "Flag keys use lowercase letters, digits, dots and underscores");
  const raw = await readJson(c);
  const b = parseOrThrow(flagBody, raw);
  return runIdempotent(c, { scope: "admin.flag", userId, body: { key, raw } }, async (tx) => {
    await tx.insert(featureFlags).values({ key, enabled: b.enabled, description: b.description ?? null, scope: b.scope }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: b.enabled, description: b.description ?? null, scope: b.scope, updatedAt: new Date() } });
    return { status: 200, body: { flag: { key, enabled: b.enabled, scope: b.scope } } };
  });
});

platformAdminRoutes.get("/events", async (c) => {
  const kind = c.req.query("kind");
  const rows = await db.select().from(platformEvents).where(kind ? eq(platformEvents.kind, kind) : sql`true`).orderBy(desc(platformEvents.createdAt)).limit(200);
  return c.json({ events: rows });
});

platformAdminRoutes.get("/ai-usage", async (c) => {
  const since = new Date(Date.now() - 14 * 86400_000);
  const byDay = await db.select({ day: aiUsageDaily.day, calls: sql<number>`sum(${aiUsageDaily.calls})::int`, costMicros: sql<number>`sum(${aiUsageDaily.costMicros})::bigint` }).from(aiUsageDaily).where(gte(aiUsageDaily.day, since.toISOString().slice(0, 10))).groupBy(aiUsageDaily.day).orderBy(asc(aiUsageDaily.day));
  const byPurpose = await db.select({ purpose: aiInteractions.purpose, status: aiInteractions.status, n: sql<number>`count(*)::int` }).from(aiInteractions).where(gte(aiInteractions.createdAt, since)).groupBy(aiInteractions.purpose, aiInteractions.status);
  return c.json({ byDay: byDay.map((d) => ({ ...d, costMicros: Number(d.costMicros) })), byPurpose, note: "Cost is in micro-units of your configured price. Set AI_PRICE_IN_MICROS_PER_MTOK and AI_PRICE_OUT_MICROS_PER_MTOK." });
});

platformAdminRoutes.get("/retention", async (c) => c.json({ policies: await db.select().from(retentionPolicies).orderBy(asc(retentionPolicies.dataClass)) }));
platformAdminRoutes.put("/retention", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ dataClass: z.enum(["chats", "financial", "identity", "evidence", "disputes", "deleted_accounts"]), marketCode: z.string().trim().max(10).optional(), retainDays: z.int().min(1).max(36500), note: z.string().trim().max(500).optional() }), raw);
  return runIdempotent(c, { scope: "admin.retention", userId, body: raw }, async (tx) => {
    const [m] = b.marketCode ? await tx.select({ id: markets.id }).from(markets).where(eq(markets.code, b.marketCode)).limit(1) : [];
    if (b.marketCode && !m) throw new ApiError(400, "unknown_market", "Unknown market code");
    await tx.delete(retentionPolicies).where(and(eq(retentionPolicies.dataClass, b.dataClass), m ? eq(retentionPolicies.marketId, m.id) : sql`${retentionPolicies.marketId} is null`));
    const [r] = await tx.insert(retentionPolicies).values({ dataClass: b.dataClass, marketId: m?.id ?? null, retainDays: b.retainDays, note: b.note ?? null }).returning({ id: retentionPolicies.id });
    return { status: 200, body: { policy: { id: r.id } } };
  });
});

// PRD §97: paid visibility is labelled and can never override qualification (enforced in ranking).
platformAdminRoutes.post("/promoted", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ providerProfileId: z.uuid(), categoryKey: z.string().trim().min(1).max(120), marketCode: z.string().trim().max(10).optional(), startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }) }), raw);
  if (new Date(b.endsAt) <= new Date(b.startsAt)) throw new ApiError(400, "invalid_range", "endsAt must be after startsAt");
  return runIdempotent(c, { scope: "admin.promoted", userId, body: raw }, async (tx) => {
    const [m] = b.marketCode ? await tx.select({ id: markets.id }).from(markets).where(eq(markets.code, b.marketCode)).limit(1) : [];
    const [p] = await tx.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.id, b.providerProfileId)).limit(1);
    if (!p) throw notFound();
    const [r] = await tx.insert(promotedListings).values({ providerProfileId: b.providerProfileId, categoryKey: b.categoryKey, marketId: m?.id ?? null, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt), createdByUserId: userId }).returning({ id: promotedListings.id });
    return { status: 201, body: { promoted: { id: r.id } } };
  });
});
platformAdminRoutes.get("/promoted", async (c) => c.json({ promoted: await db.select().from(promotedListings).orderBy(desc(promotedListings.endsAt)).limit(200) }));

platformAdminRoutes.get("/privacy-requests", async (c) => c.json({ requests: await db.select().from(privacyRequests).orderBy(desc(privacyRequests.createdAt)).limit(200) }));
platformAdminRoutes.post("/privacy-requests/:id/status", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const b = parseOrThrow(z.strictObject({ status: z.enum(["in_progress", "completed", "refused"]), note: z.string().trim().max(1000).optional() }), await readJson(c));
  return runIdempotent(c, { scope: "admin.privacy", userId, body: { id, b } }, async (tx) => {
    const r = await tx.update(privacyRequests).set({ status: b.status, note: b.note ?? null, completedAt: b.status === "in_progress" ? null : new Date() }).where(eq(privacyRequests.id, id)).returning({ u: privacyRequests.userId });
    if (r.length === 0) throw notFound();
    await notify(tx, [r[0].u], `privacy.${b.status}`, { privacyRequestId: id });
    return { status: 200, body: { request: { id, status: b.status } } };
  });
});

// ── market configuration (PRD §127-128, §160): add a country by configuration, not by forking ──
const marketDoc = z.strictObject({
  name: z.string().trim().min(1).max(120), defaultLanguage: z.string().trim().min(2).max(12), defaultCurrency: z.string().trim().length(3), defaultTimezone: z.string().trim().min(1).max(64),
  measurementSystem: z.enum(["metric", "imperial", "mixed"]), workingDays: z.array(z.int().min(0).max(6)).min(1).max(7), isActive: z.boolean().default(false),
  addressFormat: z.record(z.string(), z.unknown()).default({}), parentMarketCode: z.string().trim().max(10).optional(),
  languages: z.array(z.strictObject({ code: z.string().trim().min(2).max(12), isDefault: z.boolean().default(false) })).default([]),
  currencies: z.array(z.strictObject({ code: z.string().trim().length(3), isDefault: z.boolean().default(false) })).default([]),
  paymentMethods: z.array(z.strictObject({ methodCode: z.string().trim().max(60), providerCode: z.string().trim().max(60), supportsProtectedPayment: z.boolean().default(false), config: z.record(z.string(), z.unknown()).default({}) })).default([]),
  taxRules: z.array(z.strictObject({ taxCode: z.string().trim().max(40), rateBps: z.int().min(0).max(100000), appliesTo: z.record(z.string(), z.unknown()).default({}), effectiveFrom: z.iso.date(), effectiveTo: z.iso.date().optional() })).default([]),
  holidays: z.array(z.strictObject({ date: z.iso.date(), name: z.string().trim().max(120) })).default([]),
  verificationRules: z.array(z.strictObject({ verificationClass: z.enum(["contact", "identity", "address", "business", "skill", "professional_licence", "insurance", "platform_performance"]), adapterCode: z.string().trim().max(60), acceptedDocuments: z.array(z.string().max(80)).default([]), requiredForPayout: z.boolean().default(false) })).default([]),
  compliance: z.record(z.string(), z.unknown()).default({}),
});
platformAdminRoutes.put("/markets/:code", async (c) => {
  const userId = c.get("auth").userId;
  const code = c.req.param("code").trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,10}$/.test(code)) throw new ApiError(400, "invalid_code", "Market codes look like NG, GH or NG-LA");
  const raw = await readJson(c);
  const b = parseOrThrow(marketDoc, raw);
  if (!isIanaTimezone(b.defaultTimezone)) throw new ApiError(400, "invalid_timezone", "defaultTimezone must be an IANA name");
  return runIdempotent(c, { scope: "admin.market", userId, body: { code, raw } }, async (tx) => {
    const langs = [...new Set([b.defaultLanguage, ...b.languages.map((l) => l.code)])];
    const known = await tx.select({ c: languages.code }).from(languages).where(inArray(languages.code, langs));
    if (known.length !== langs.length) throw new ApiError(400, "unknown_language", "Add the language to the languages table first");
    const curs = [...new Set([b.defaultCurrency, ...b.currencies.map((x) => x.code)])];
    const kc = await tx.select({ c: currencies.code }).from(currencies).where(inArray(currencies.code, curs));
    if (kc.length !== curs.length) throw new ApiError(400, "unknown_currency", "Add the currency to the currencies table first");
    const [parent] = b.parentMarketCode ? await tx.select({ id: markets.id }).from(markets).where(eq(markets.code, b.parentMarketCode)).limit(1) : [];
    const vals = { name: b.name, defaultLanguage: b.defaultLanguage, defaultCurrency: b.defaultCurrency, defaultTimezone: b.defaultTimezone, measurementSystem: b.measurementSystem, workingDays: b.workingDays, isActive: b.isActive, addressFormat: b.addressFormat, parentMarketId: parent?.id ?? null };
    const [m] = await tx.insert(markets).values({ code, ...vals }).onConflictDoUpdate({ target: markets.code, set: { ...vals, updatedAt: new Date() } }).returning({ id: markets.id });
    for (const l of b.languages.length > 0 ? b.languages : [{ code: b.defaultLanguage, isDefault: true }]) await tx.insert(marketLanguages).values({ marketId: m.id, languageCode: l.code, isDefault: l.isDefault }).onConflictDoUpdate({ target: [marketLanguages.marketId, marketLanguages.languageCode], set: { isDefault: l.isDefault } });
    for (const x of b.currencies.length > 0 ? b.currencies : [{ code: b.defaultCurrency, isDefault: true }]) await tx.insert(marketCurrencies).values({ marketId: m.id, currencyCode: x.code, isDefault: x.isDefault }).onConflictDoUpdate({ target: [marketCurrencies.marketId, marketCurrencies.currencyCode], set: { isDefault: x.isDefault } });
    for (const pm of b.paymentMethods) await tx.insert(marketPaymentMethods).values({ marketId: m.id, methodCode: pm.methodCode, providerCode: pm.providerCode, supportsProtectedPayment: pm.supportsProtectedPayment, config: pm.config }).onConflictDoUpdate({ target: [marketPaymentMethods.marketId, marketPaymentMethods.methodCode, marketPaymentMethods.providerCode], set: { supportsProtectedPayment: pm.supportsProtectedPayment, config: pm.config } });
    if (b.taxRules.length > 0) {
      await tx.delete(marketTaxRules).where(eq(marketTaxRules.marketId, m.id));
      await tx.insert(marketTaxRules).values(b.taxRules.map((t) => ({ marketId: m.id, taxCode: t.taxCode, rateBps: t.rateBps, appliesTo: t.appliesTo, effectiveFrom: t.effectiveFrom, effectiveTo: t.effectiveTo ?? null })));
    }
    for (const h of b.holidays) await tx.insert(marketHolidays).values({ marketId: m.id, holidayDate: h.date, name: h.name }).onConflictDoUpdate({ target: [marketHolidays.marketId, marketHolidays.holidayDate], set: { name: h.name } });
    for (const v of b.verificationRules) await tx.insert(marketVerificationRules).values({ marketId: m.id, verificationClass: v.verificationClass, adapterCode: v.adapterCode, acceptedDocuments: v.acceptedDocuments, requiredForPayout: v.requiredForPayout }).onConflictDoUpdate({ target: [marketVerificationRules.marketId, marketVerificationRules.verificationClass], set: { adapterCode: v.adapterCode, acceptedDocuments: v.acceptedDocuments, requiredForPayout: v.requiredForPayout } });
    for (const [k, v] of Object.entries(b.compliance)) await tx.insert(marketComplianceSettings).values({ marketId: m.id, key: k, value: v }).onConflictDoUpdate({ target: [marketComplianceSettings.marketId, marketComplianceSettings.key], set: { value: v, updatedAt: new Date() } });
    return { status: 200, body: { market: { id: m.id, code, isActive: b.isActive } } };
  });
});
platformAdminRoutes.get("/markets", async (c) => c.json({ markets: await db.select().from(markets).orderBy(asc(markets.code)) }));

// ── scheduled jobs (PRD §72 reminders, §89 expiry, §118 recurring, §130 housekeeping) ──
// Call from any scheduler (Vercel Cron, GitHub Actions, cron-job.org) with header x-cron-secret: $CRON_SECRET.
export const jobRoutes = new Hono<AuthEnv>();
function cron(c: Context) {
  const secret = process.env.CRON_SECRET;
  if (!secret || c.req.header("x-cron-secret") !== secret) throw notFound();
}
jobRoutes.post("/recurring", async (c) => {
  cron(c);
  const today = new Date().toISOString().slice(0, 10);
  const due = await db.select({ id: recurringServices.id }).from(recurringServices).where(and(eq(recurringServices.isActive, true), lte(recurringServices.nextDueOn, today))).limit(200);
  let generated = 0;
  for (const d of due) {
    try { await db.transaction(async (tx) => { if (await generateOccurrence(tx, d.id)) generated += 1; }); }
    catch (e) { await logEvent(db, "job.failed", "error", { job: "recurring", id: d.id, message: e instanceof Error ? e.message.slice(0, 200) : "unknown" }); }
  }
  return c.json({ due: due.length, generated });
});
jobRoutes.post("/credentials", async (c) => {
  cron(c);
  const today = new Date().toISOString().slice(0, 10);
  const v = await db.update(verifications).set({ status: "expired" }).where(and(eq(verifications.status, "verified"), lt(verifications.expiresAt, today))).returning({ uid: verifications.userId });
  const i = await db.update(insuranceRecords).set({ status: "expired" }).where(and(eq(insuranceRecords.status, "verified"), lt(insuranceRecords.expiresOn, today))).returning({ id: insuranceRecords.id });
  for (const uid of new Set(v.map((x) => x.uid))) await notify(db, [uid], "verification.expired", {});
  return c.json({ verificationsExpired: v.length, insuranceExpired: i.length });
});
jobRoutes.post("/cleanup", async (c) => {
  cron(c);
  const s = await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning({ id: sessions.id });
  const r = await db.delete(rateLimitHits).where(lt(rateLimitHits.windowStart, new Date(Date.now() - 86400_000))).returning({ k: rateLimitHits.key });
  const k = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - 7 * 86400_000))).returning({ k: idempotencyKeys.key });
  return c.json({ sessionsDeleted: s.length, rateLimitRowsDeleted: r.length, idempotencyKeysDeleted: k.length });
});
