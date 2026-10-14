import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import {
  assignments, insuranceRecords, languages, moderationReports, notificationPreferences, projectMembers, projects, providerProfiles, providerTeamMembers,
  providerTeams, reviews, subcontractRequests, tasks, users, verifications, privacyRequests, messages, requests, aiInteractions,
} from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { requirePlatformAdmin } from "../authz/platform-admin";
import { PROJECT_MANAGERS, requireProjectRole } from "../authz/projects";
import { manualIdentityVerifier } from "../ai/providers";
import { recordActivity } from "../lib/activity";
import { runIdempotent } from "../lib/idempotency";
import { managerUserIds, notify } from "../lib/notify";
import type { Executor } from "../db/types";
import { ApiError, isIanaTimezone, parseOrThrow, readJson, uuidParam } from "./http";

const notFound = () => new ApiError(404, "not_found", "Not found");
const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do this");
async function myProfileId(ex: Executor, userId: string): Promise<string> {
  const [p] = await ex.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
  if (!p) throw notFound();
  return p.id;
}

// ── verification framework (PRD §88-89): classes + expiry; country adapters decide what is acceptable ──
export const verificationRoutes = new Hono<AuthEnv>();
verificationRoutes.use("*", requireAuth);
const verifyBody = z.strictObject({
  verificationClass: z.enum(["contact", "identity", "address", "business", "skill", "professional_licence", "insurance", "platform_performance"]),
  issuer: z.string().trim().max(200).optional(),
  issuedAt: z.iso.date().optional(),
  expiresAt: z.iso.date().optional(),
  documentRef: z.string().trim().max(500).optional(),
});
verificationRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(verifyBody, raw);
  if (b.verificationClass === "platform_performance") throw new ApiError(400, "not_user_submitted", "This class is earned from work history, not submitted");
  return runIdempotent(c, { scope: "verifications.submit", userId, body: raw }, async (tx) => {
    const [me] = await tx.select({ marketId: users.marketId }).from(users).where(eq(users.id, userId)).limit(1);
    const [prof] = await tx.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
    const out = await manualIdentityVerifier.verify({ userId, verificationClass: b.verificationClass, marketCode: "", documentRef: b.documentRef ?? null });
    const [row] = await tx.insert(verifications).values({
      userId, providerProfileId: prof?.id ?? null, verificationClass: b.verificationClass, status: out.status, issuer: b.issuer ?? out.issuer, marketId: me?.marketId ?? null,
      issuedAt: b.issuedAt ?? null, expiresAt: b.expiresAt ?? null, documentRef: b.documentRef ?? null,
    }).returning({ id: verifications.id, status: verifications.status });
    return { status: 201, body: { verification: row } };
  });
});
verificationRoutes.get("/mine", async (c) => {
  const rows = await db.select().from(verifications).where(eq(verifications.userId, c.get("auth").userId)).orderBy(desc(verifications.createdAt));
  return c.json({ verifications: rows });
});
verificationRoutes.get("/", async (c) => {
  requirePlatformAdmin(c.get("auth").userId);
  const status = c.req.query("status") ?? "pending";
  const rows = await db.select({ v: verifications, name: users.displayName }).from(verifications).innerJoin(users, eq(users.id, verifications.userId))
    .where(sql`${verifications.status} = ${status}`).orderBy(asc(verifications.createdAt)).limit(200);
  return c.json({ verifications: rows.map((r) => ({ ...r.v, userName: r.name })) });
});
const decideBody = z.strictObject({ decision: z.enum(["verified", "rejected", "revoked"]) });
verificationRoutes.post("/:id/decide", async (c) => {
  const userId = c.get("auth").userId;
  requirePlatformAdmin(userId);
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(decideBody, raw);
  return runIdempotent(c, { scope: "verifications.decide", userId, body: { id, raw } }, async (tx) => {
    const r = await tx.update(verifications).set({ status: b.decision }).where(eq(verifications.id, id)).returning({ uid: verifications.userId });
    if (r.length === 0) throw notFound();
    await notify(tx, [r[0].uid], `verification.${b.decision}`, { verificationId: id });
    return { status: 200, body: { verification: { id, status: b.decision } } };
  });
});

// ── insurance (PRD §81) ──────────────────────────────────────────────────────
export const insuranceRoutes = new Hono<AuthEnv>();
insuranceRoutes.use("*", requireAuth);
const insuranceBody = z.strictObject({
  kind: z.enum(["professional_indemnity", "public_liability", "worker", "vehicle", "project"]),
  insurer: z.string().trim().max(200).optional(),
  policyRef: z.string().trim().max(200).optional(),
  coverMinor: z.int().min(0).optional(),
  currency: z.string().trim().length(3).optional(),
  expiresOn: z.iso.date(),
});
insuranceRoutes.post("/me/insurance", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(insuranceBody, raw);
  if ((b.coverMinor !== undefined) !== (b.currency !== undefined)) throw new ApiError(400, "currency_required", "Cover needs a currency");
  return runIdempotent(c, { scope: "insurance.add", userId, body: raw }, async (tx) => {
    const pid = await myProfileId(tx, userId);
    const [row] = await tx.insert(insuranceRecords).values({ providerProfileId: pid, kind: b.kind, insurer: b.insurer ?? null, policyRef: b.policyRef ?? null, coverMinor: b.coverMinor ?? null, currency: b.currency ?? null, expiresOn: b.expiresOn }).returning({ id: insuranceRecords.id });
    return { status: 201, body: { insurance: { id: row.id, status: "pending" } } };
  });
});
insuranceRoutes.get("/me/insurance", async (c) => {
  const pid = await myProfileId(db, c.get("auth").userId);
  return c.json({ insurance: await db.select().from(insuranceRecords).where(eq(insuranceRecords.providerProfileId, pid)).orderBy(desc(insuranceRecords.expiresOn)) });
});
// Customers see only kind, status and expiry. Policy numbers stay private.
insuranceRoutes.get("/:id/insurance", async (c) => {
  const pid = uuidParam(c.req.param("id"));
  const rows = await db.select({ kind: insuranceRecords.kind, status: insuranceRecords.status, expiresOn: insuranceRecords.expiresOn }).from(insuranceRecords).where(and(eq(insuranceRecords.providerProfileId, pid), eq(insuranceRecords.status, "verified")));
  const today = new Date().toISOString().slice(0, 10);
  return c.json({ insurance: rows.map((r) => ({ ...r, expired: r.expiresOn < today })) });
});
export const insuranceAdminRoutes = new Hono<AuthEnv>();
insuranceAdminRoutes.use("*", requireAuth);
insuranceAdminRoutes.post("/:id/decide", async (c) => {
  const userId = c.get("auth").userId;
  requirePlatformAdmin(userId);
  const id = uuidParam(c.req.param("id"));
  const b = parseOrThrow(z.strictObject({ decision: z.enum(["verified", "rejected"]) }), await readJson(c));
  return runIdempotent(c, { scope: "insurance.decide", userId, body: { id, b } }, async (tx) => {
    const r = await tx.update(insuranceRecords).set({ status: b.decision }).where(eq(insuranceRecords.id, id)).returning({ id: insuranceRecords.id });
    if (r.length === 0) throw notFound();
    return { status: 200, body: { insurance: { id, status: b.decision } } };
  });
});

// ── explainable trust (PRD §91-94): every component is shown, nothing is a black box ──
export async function trustProfile(ex: Executor, providerId: string) {
  const [p] = await ex.select().from(providerProfiles).where(eq(providerProfiles.id, providerId)).limit(1);
  if (!p) return null;
  const today = new Date().toISOString().slice(0, 10);
  const ver = await ex.select({ cls: verifications.verificationClass, expiresAt: verifications.expiresAt, issuer: verifications.issuer }).from(verifications)
    .where(and(eq(verifications.userId, p.userId), eq(verifications.status, "verified"), or(isNull(verifications.expiresAt), sql`${verifications.expiresAt} >= ${today}`)));
  const asg = await ex.select({ status: assignments.status, n: sql<number>`count(*)::int` }).from(assignments).where(eq(assignments.providerProfileId, providerId)).groupBy(assignments.status);
  const completed = asg.find((a) => a.status === "completed")?.n ?? 0;
  const failed = asg.filter((a) => ["rejected", "withdrawn", "cancelled"].includes(a.status)).reduce((n, a) => n + a.n, 0);
  const timing = await ex.select({ plannedEnd: tasks.plannedEnd, actualEnd: tasks.actualEnd }).from(assignments).innerJoin(tasks, eq(tasks.id, assignments.taskId))
    .where(and(eq(assignments.providerProfileId, providerId), eq(assignments.status, "completed")));
  const timed = timing.filter((t) => t.plannedEnd && t.actualEnd);
  const onTime = timed.filter((t) => (t.actualEnd as Date).getTime() <= (t.plannedEnd as Date).getTime()).length;
  const [rv] = await ex.select({
    n: sql<number>`count(*)::int`, w: sql<string | null>`avg(${reviews.workmanship})`, pu: sql<string | null>`avg(${reviews.punctuality})`,
    co: sql<string | null>`avg(${reviews.communication})`, pr: sql<string | null>`avg(${reviews.professionalism})`, qa: sql<string | null>`avg(${reviews.quoteAccuracy})`,
  }).from(reviews).where(eq(reviews.providerProfileId, providerId));
  const repeat = await ex.select({ owner: projects.ownerUserId, n: sql<number>`count(*)::int` }).from(assignments)
    .innerJoin(tasks, eq(tasks.id, assignments.taskId)).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(assignments.providerProfileId, providerId), eq(assignments.status, "completed"))).groupBy(projects.ownerUserId);
  const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
  return {
    providerId, displayName: p.displayName,
    verification: { verifiedClasses: ver.map((v) => ({ class: v.cls, expiresAt: v.expiresAt, issuer: v.issuer })) },
    workHistory: {
      completedJobs: completed, notCompleted: failed, completionRate: completed + failed > 0 ? Math.round((completed / (completed + failed)) * 100) : null,
      onTimeRate: timed.length > 0 ? Math.round((onTime / timed.length) * 100) : null, onTimeBasis: timed.length,
      repeatCustomers: repeat.filter((r) => r.n > 1).length,
    },
    reviews: { count: rv?.n ?? 0, workmanship: num(rv?.w), punctuality: num(rv?.pu), communication: num(rv?.co), professionalism: num(rv?.pr), quoteAccuracy: num(rv?.qa) },
    howToRead: "Each number comes from recorded work and reviews. There is no hidden score. A provider with no history is new, not untrusted.",
  };
}
export const trustRoutes = new Hono<AuthEnv>();
trustRoutes.use("*", requireAuth);
trustRoutes.get("/:id/trust", async (c) => {
  const t = await trustProfile(db, uuidParam(c.req.param("id")));
  if (!t) throw notFound();
  return c.json({ trust: t });
});

// PRD §93: limited, non-retaliatory customer signals, shown only to a provider who has an assignment on that project.
export const customerSignalRoutes = new Hono<AuthEnv>();
customerSignalRoutes.use("*", requireAuth);
customerSignalRoutes.get("/:id/customer-signals", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const pid = await myProfileId(db, userId).catch(() => null);
  if (!pid) throw forbidden();
  const [mine] = await db.select({ id: assignments.id }).from(assignments).innerJoin(tasks, eq(tasks.id, assignments.taskId)).where(and(eq(tasks.projectId, projectId), eq(assignments.providerProfileId, pid))).limit(1);
  if (!mine) throw notFound();
  const [p] = await db.select({ owner: projects.ownerUserId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) throw notFound();
  const owned = await db.select({ id: projects.id }).from(projects).where(eq(projects.ownerUserId, p.owner));
  const ids = owned.map((o) => o.id);
  const done = ids.length > 0 ? await db.select({ n: sql<number>`count(*)::int` }).from(projects).where(and(inArray(projects.id, ids), eq(projects.status, "completed"))) : [{ n: 0 }];
  return c.json({ signals: { projectsOnPlatform: ids.length, projectsCompleted: done[0]?.n ?? 0 }, note: "Only counts are shown. There are no ratings of customers." });
});

// ── subcontracting (PRD §90): never silent ───────────────────────────────────
export const subcontractAssignmentRoutes = new Hono<AuthEnv>();
subcontractAssignmentRoutes.use("*", requireAuth);
export const subcontractRoutes = new Hono<AuthEnv>();
subcontractRoutes.use("*", requireAuth);
const subBody = z.strictObject({ subcontractorProviderId: z.uuid(), scope: z.string().trim().min(3).max(2000) });
subcontractAssignmentRoutes.post("/:id/subcontract", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(subBody, raw);
  return runIdempotent(c, { scope: "subcontract.request", userId, body: { id, raw } }, async (tx) => {
    const pid = await myProfileId(tx, userId);
    const [a] = await tx.select({ a: assignments, projectId: tasks.projectId }).from(assignments).innerJoin(tasks, eq(tasks.id, assignments.taskId)).where(eq(assignments.id, id)).limit(1);
    if (!a || a.a.providerProfileId !== pid) throw notFound();
    if (!["accepted", "active"].includes(a.a.status)) throw new ApiError(409, "not_active", "Only accepted or active work can be subcontracted");
    if (b.subcontractorProviderId === pid) throw new ApiError(400, "self", "You cannot subcontract to yourself");
    const [sub] = await tx.select({ id: providerProfiles.id }).from(providerProfiles).where(and(eq(providerProfiles.id, b.subcontractorProviderId), eq(providerProfiles.isActive, true))).limit(1);
    if (!sub) throw new ApiError(404, "not_found", "That provider does not exist");
    const [row] = await tx.insert(subcontractRequests).values({ assignmentId: id, requestedByProviderId: pid, subcontractorProviderId: b.subcontractorProviderId, scope: b.scope }).returning({ id: subcontractRequests.id });
    await recordActivity(tx, { projectId: a.projectId, actorUserId: userId, eventType: "subcontract.requested", subjectType: "assignment", subjectId: id, payload: { subcontractRequestId: row.id } });
    await notify(tx, await managerUserIds(tx, a.projectId), "subcontract.requested", { projectId: a.projectId, subcontractRequestId: row.id }, userId);
    return { status: 201, body: { subcontract: { id: row.id, status: "pending" } } };
  });
});
subcontractRoutes.post("/:id/decide", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const b = parseOrThrow(z.strictObject({ decision: z.enum(["approved", "rejected"]) }), await readJson(c));
  return runIdempotent(c, { scope: "subcontract.decide", userId, body: { id, b } }, async (tx) => {
    const [s] = await tx.select({ s: subcontractRequests, projectId: tasks.projectId }).from(subcontractRequests)
      .innerJoin(assignments, eq(assignments.id, subcontractRequests.assignmentId)).innerJoin(tasks, eq(tasks.id, assignments.taskId)).where(eq(subcontractRequests.id, id)).limit(1).for("update");
    if (!s) throw notFound();
    await requireProjectRole(tx, s.projectId, userId, PROJECT_MANAGERS);
    if (s.s.status !== "pending") throw new ApiError(409, "not_pending", `A ${s.s.status} request cannot be decided`);
    await tx.update(subcontractRequests).set({ status: b.decision, decidedByUserId: userId, decidedAt: new Date() }).where(eq(subcontractRequests.id, id));
    const [subUser] = await tx.select({ uid: providerProfiles.userId }).from(providerProfiles).where(eq(providerProfiles.id, s.s.subcontractorProviderId)).limit(1);
    const [reqUser] = await tx.select({ uid: providerProfiles.userId }).from(providerProfiles).where(eq(providerProfiles.id, s.s.requestedByProviderId)).limit(1);
    if (b.decision === "approved" && subUser) await tx.insert(projectMembers).values({ projectId: s.projectId, userId: subUser.uid, role: "provider_team_member" }).onConflictDoNothing();
    await recordActivity(tx, { projectId: s.projectId, actorUserId: userId, eventType: `subcontract.${b.decision}`, subjectType: "assignment", subjectId: s.s.assignmentId, payload: {} });
    await notify(tx, [reqUser?.uid, subUser?.uid].filter((x): x is string => !!x), `subcontract.${b.decision}`, { projectId: s.projectId }, userId);
    return { status: 200, body: { subcontract: { id, status: b.decision } } };
  });
});
subcontractAssignmentRoutes.get("/:id/subcontracts", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const [a] = await db.select({ a: assignments, projectId: tasks.projectId }).from(assignments).innerJoin(tasks, eq(tasks.id, assignments.taskId)).where(eq(assignments.id, id)).limit(1);
  if (!a) throw notFound();
  const pid = await myProfileId(db, userId).catch(() => null);
  if (a.a.providerProfileId !== pid) await requireProjectRole(db, a.projectId, userId, PROJECT_MANAGERS);
  return c.json({ subcontracts: await db.select().from(subcontractRequests).where(eq(subcontractRequests.assignmentId, id)).orderBy(desc(subcontractRequests.createdAt)) });
});

// ── provider teams (PRD §12) ─────────────────────────────────────────────────
export const teamRoutes = new Hono<AuthEnv>();
teamRoutes.use("*", requireAuth);
teamRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ name: z.string().trim().min(1).max(120) }), raw);
  return runIdempotent(c, { scope: "teams.create", userId, body: raw }, async (tx) => {
    const pid = await myProfileId(tx, userId);
    const [t] = await tx.insert(providerTeams).values({ name: b.name, leaderProviderProfileId: pid }).returning({ id: providerTeams.id });
    await tx.insert(providerTeamMembers).values({ teamId: t.id, providerProfileId: pid, role: "leader", permissions: ["assign_tasks", "manage_members", "view_revenue"] });
    return { status: 201, body: { team: { id: t.id, name: b.name } } };
  });
});
teamRoutes.get("/", async (c) => {
  const pid = await myProfileId(db, c.get("auth").userId).catch(() => null);
  if (!pid) return c.json({ teams: [] });
  const mine = await db.select({ t: providerTeams, role: providerTeamMembers.role }).from(providerTeamMembers).innerJoin(providerTeams, eq(providerTeams.id, providerTeamMembers.teamId)).where(eq(providerTeamMembers.providerProfileId, pid));
  const out = [];
  for (const m of mine) {
    const members = await db.select({ providerId: providerTeamMembers.providerProfileId, role: providerTeamMembers.role, revenueShareBps: providerTeamMembers.revenueShareBps, permissions: providerTeamMembers.permissions, name: providerProfiles.displayName })
      .from(providerTeamMembers).innerJoin(providerProfiles, eq(providerProfiles.id, providerTeamMembers.providerProfileId)).where(eq(providerTeamMembers.teamId, m.t.id));
    out.push({ id: m.t.id, name: m.t.name, myRole: m.role, leaderId: m.t.leaderProviderProfileId, members });
  }
  return c.json({ teams: out });
});
const memberBody = z.strictObject({ providerProfileId: z.uuid(), role: z.string().trim().min(1).max(60).default("member"), revenueShareBps: z.int().min(0).max(10000).default(0), permissions: z.array(z.string().trim().max(60)).max(20).default([]) });
teamRoutes.post("/:id/members", async (c) => {
  const userId = c.get("auth").userId;
  const teamId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(memberBody, raw);
  return runIdempotent(c, { scope: "teams.add_member", userId, body: { teamId, raw } }, async (tx) => {
    const pid = await myProfileId(tx, userId);
    const [t] = await tx.select().from(providerTeams).where(eq(providerTeams.id, teamId)).limit(1).for("update");
    if (!t || t.leaderProviderProfileId !== pid) throw notFound();
    const members = await tx.select({ share: providerTeamMembers.revenueShareBps, id: providerTeamMembers.providerProfileId }).from(providerTeamMembers).where(eq(providerTeamMembers.teamId, teamId));
    const total = members.filter((m) => m.id !== b.providerProfileId).reduce((n, m) => n + m.share, 0) + b.revenueShareBps;
    if (total > 10000) throw new ApiError(400, "share_over_100", "Revenue shares in a team cannot add up to more than 100%");
    const [target] = await tx.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.id, b.providerProfileId)).limit(1);
    if (!target) throw new ApiError(404, "not_found", "That provider does not exist");
    await tx.insert(providerTeamMembers).values({ teamId, providerProfileId: b.providerProfileId, role: b.role, revenueShareBps: b.revenueShareBps, permissions: b.permissions })
      .onConflictDoUpdate({ target: [providerTeamMembers.teamId, providerTeamMembers.providerProfileId], set: { role: b.role, revenueShareBps: b.revenueShareBps, permissions: b.permissions } });
    return { status: 200, body: { member: { providerProfileId: b.providerProfileId, role: b.role } } };
  });
});

// ── account: language, notification preferences, provider profile edits, privacy (PRD §26, §113, §130-131) ──
export const accountRoutes = new Hono<AuthEnv>();
accountRoutes.use("*", requireAuth);
const prefsBody = z.strictObject({
  preferredLanguage: z.string().trim().min(2).max(12).optional(),
  secondaryLanguages: z.array(z.string().trim().min(2).max(12)).max(10).optional(),
  autoTranslate: z.boolean().optional(),
  showOriginalByDefault: z.boolean().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});
accountRoutes.patch("/preferences", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(prefsBody, raw);
  if (b.timezone && !isIanaTimezone(b.timezone)) throw new ApiError(400, "invalid_timezone", "timezone must be an IANA name such as Africa/Lagos");
  return runIdempotent(c, { scope: "me.preferences", userId, body: raw }, async (tx) => {
    const wanted = [...(b.preferredLanguage ? [b.preferredLanguage] : []), ...(b.secondaryLanguages ?? [])];
    if (wanted.length > 0) {
      const known = await tx.select({ c: languages.code }).from(languages).where(inArray(languages.code, wanted));
      if (known.length !== new Set(wanted).size) throw new ApiError(400, "unknown_language", "One of those languages is not supported");
    }
    const set: Partial<typeof users.$inferInsert> = {};
    if (b.preferredLanguage !== undefined) set.preferredLanguage = b.preferredLanguage;
    if (b.secondaryLanguages !== undefined) set.secondaryLanguages = [...new Set(b.secondaryLanguages)];
    if (b.autoTranslate !== undefined) set.autoTranslate = b.autoTranslate;
    if (b.showOriginalByDefault !== undefined) set.showOriginalByDefault = b.showOriginalByDefault;
    if (b.timezone !== undefined) set.timezone = b.timezone;
    if (Object.keys(set).length === 0) throw new ApiError(400, "nothing_to_update", "Send at least one setting");
    await tx.update(users).set(set).where(eq(users.id, userId));
    return { status: 200, body: { updated: Object.keys(set) } };
  });
});

const providerPatch = z.strictObject({
  displayName: z.string().trim().min(1).max(120).optional(),
  headline: z.string().trim().max(200).optional(),
  bio: z.string().trim().max(3000).optional(),
  remoteOk: z.boolean().optional(),
});
accountRoutes.patch("/provider", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(providerPatch, raw);
  return runIdempotent(c, { scope: "me.provider_patch", userId, body: raw }, async (tx) => {
    const pid = await myProfileId(tx, userId);
    if (Object.keys(b).length === 0) throw new ApiError(400, "nothing_to_update", "Send at least one field");
    await tx.update(providerProfiles).set(b).where(eq(providerProfiles.id, pid));
    return { status: 200, body: { updated: Object.keys(b) } };
  });
});

accountRoutes.get("/notification-preferences", async (c) => {
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, c.get("auth").userId));
  return c.json({ preferences: rows });
});
const notifBody = z.strictObject({
  preferences: z.array(z.strictObject({
    channel: z.enum(["in_app", "push", "email", "sms", "messaging"]),
    kindPrefix: z.string().trim().max(60).default(""),
    enabled: z.boolean(),
    quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  })).min(1).max(40),
});
accountRoutes.put("/notification-preferences", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(notifBody, raw);
  return runIdempotent(c, { scope: "me.notification_prefs", userId, body: raw }, async (tx) => {
    for (const p of b.preferences) {
      await tx.insert(notificationPreferences).values({ userId, channel: p.channel, kindPrefix: p.kindPrefix, enabled: p.enabled, quietStart: p.quietStart ?? null, quietEnd: p.quietEnd ?? null })
        .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.channel, notificationPreferences.kindPrefix], set: { enabled: p.enabled, quietStart: p.quietStart ?? null, quietEnd: p.quietEnd ?? null } });
    }
    return { status: 200, body: { saved: b.preferences.length } };
  });
});

// Privacy: export is immediate and complete for the person's own data; deletion is recorded for review because financial
// and audit records may have to be kept (PRD §131).
accountRoutes.post("/privacy-requests", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ kind: z.enum(["export", "delete", "restrict"]), note: z.string().trim().max(1000).optional() }), raw);
  return runIdempotent(c, { scope: "me.privacy", userId, body: raw }, async (tx) => {
    const [row] = await tx.insert(privacyRequests).values({ userId, kind: b.kind, note: b.note ?? null, status: b.kind === "export" ? "completed" : "received", completedAt: b.kind === "export" ? new Date() : null }).returning({ id: privacyRequests.id });
    if (b.kind !== "export") return { status: 201, body: { request: { id: row.id, status: "received" }, note: "A person reviews this. Records the law requires us to keep, such as financial records, are retained." } };
    const [me] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    const [prof] = await tx.select().from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
    const reqs = await tx.select().from(requests).where(eq(requests.requesterUserId, userId));
    const projs = await tx.select({ id: projects.id, title: projects.title, status: projects.status, createdAt: projects.createdAt }).from(projects).where(eq(projects.ownerUserId, userId));
    const msgs = await tx.select({ text: messages.originalText, language: messages.originalLanguage, createdAt: messages.createdAt }).from(messages).where(eq(messages.senderUserId, userId)).limit(5000);
    const ver = await tx.select().from(verifications).where(eq(verifications.userId, userId));
    const ai = await tx.select({ purpose: aiInteractions.purpose, createdAt: aiInteractions.createdAt, status: aiInteractions.status }).from(aiInteractions).where(eq(aiInteractions.userId, userId)).limit(2000);
    return { status: 201, body: { request: { id: row.id, status: "completed" }, export: { exportedAt: new Date().toISOString(), account: me, providerProfile: prof ?? null, requests: reqs, projectsOwned: projs, messagesSent: msgs, verifications: ver, aiUsage: ai } } };
  });
});

// ── moderation (PRD §98) ─────────────────────────────────────────────────────
export const moderationRoutes = new Hono<AuthEnv>();
moderationRoutes.use("*", requireAuth);
moderationRoutes.post("/reports", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({
    targetType: z.enum(["message", "user", "provider", "listing"]), targetId: z.uuid(),
    reason: z.enum(["spam", "harassment", "threat", "fraud", "prohibited", "impersonation", "contact_leak", "payment_manipulation", "other"]),
    detail: z.string().trim().max(2000).optional(),
  }), raw);
  return runIdempotent(c, { scope: "moderation.report", userId, body: raw }, async (tx) => {
    const [row] = await tx.insert(moderationReports).values({ reporterUserId: userId, targetType: b.targetType, targetId: b.targetId, reason: b.reason, detail: b.detail ?? null }).returning({ id: moderationReports.id });
    return { status: 201, body: { report: { id: row.id, status: "open" } } };
  });
});
moderationRoutes.get("/reports", async (c) => {
  requirePlatformAdmin(c.get("auth").userId);
  const status = c.req.query("status") ?? "open";
  return c.json({ reports: await db.select().from(moderationReports).where(eq(moderationReports.status, status)).orderBy(desc(moderationReports.createdAt)).limit(200) });
});
moderationRoutes.post("/reports/:id/resolve", async (c) => {
  const userId = c.get("auth").userId;
  requirePlatformAdmin(userId);
  const id = uuidParam(c.req.param("id"));
  const b = parseOrThrow(z.strictObject({ status: z.enum(["actioned", "dismissed"]) }), await readJson(c));
  return runIdempotent(c, { scope: "moderation.resolve", userId, body: { id, b } }, async (tx) => {
    const r = await tx.update(moderationReports).set({ status: b.status, resolvedAt: new Date() }).where(eq(moderationReports.id, id)).returning({ id: moderationReports.id });
    if (r.length === 0) throw notFound();
    return { status: 200, body: { report: { id, status: b.status } } };
  });
});

