import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import {
  approvalPolicies, approvalRequests, assignments, checkIns, bookings, costCentres, currencies, milestones, orgBudgets, orgDepartments,
  organisationMembers, organisations, orgPreferredProviders, orgSites, projectBudgets, projects, providerProfiles, quotes, slaPolicies, taskInvitations, tasks, users,
} from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { requireOrgMember, type OrgRole } from "../authz/organisations";
import { runIdempotent } from "../lib/idempotency";
import { notify } from "../lib/notify";
import { logEvent } from "../lib/events";
import type { Executor } from "../db/types";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http";

// PRD §7-8 (businesses, institutions), §76 (SLAs), §114-118 (roles, approval chains, budgets, facilities).
// Approvals are an explicit workflow here: `requiresApproval()` is the one function other flows call to gate themselves.

const ADMINS: readonly OrgRole[] = ["owner", "admin"];
const FINANCE: readonly OrgRole[] = ["owner", "admin", "finance_approver"];
const notFound = () => new ApiError(404, "not_found", "Not found");

export const orgRoutes = new Hono<AuthEnv>();
orgRoutes.use("*", requireAuth);

const createBody = z.strictObject({ name: z.string().trim().min(1).max(200), type: z.enum(["business", "government", "ngo", "institution", "service_company", "merchant"]), parentOrganisationId: z.uuid().optional() });
orgRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(createBody, raw);
  return runIdempotent(c, { scope: "orgs.create", userId, body: raw }, async (tx) => {
    const [me] = await tx.select({ marketId: users.marketId }).from(users).where(eq(users.id, userId)).limit(1);
    if (b.parentOrganisationId) await requireOrgMember(tx, b.parentOrganisationId, userId, ADMINS);
    const [o] = await tx.insert(organisations).values({ name: b.name, type: b.type, marketId: me?.marketId ?? null, parentOrganisationId: b.parentOrganisationId ?? null }).returning({ id: organisations.id });
    await tx.insert(organisationMembers).values({ organisationId: o.id, userId, role: "owner" });
    return { status: 201, body: { organisation: { id: o.id, name: b.name, type: b.type } } };
  });
});

orgRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const rows = await db.select({ o: organisations, role: organisationMembers.role }).from(organisationMembers).innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId)).where(eq(organisationMembers.userId, userId));
  const byId = new Map<string, { id: string; name: string; type: string; parentOrganisationId: string | null; roles: string[] }>();
  for (const r of rows) {
    const e = byId.get(r.o.id) ?? { id: r.o.id, name: r.o.name, type: r.o.type, parentOrganisationId: r.o.parentOrganisationId, roles: [] };
    e.roles.push(r.role);
    byId.set(r.o.id, e);
  }
  return c.json({ organisations: [...byId.values()] });
});

orgRoutes.get("/:id/members", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  await requireOrgMember(db, id, userId);
  const rows = await db.select({ userId: organisationMembers.userId, role: organisationMembers.role, name: users.displayName, email: users.email }).from(organisationMembers).innerJoin(users, eq(users.id, organisationMembers.userId)).where(eq(organisationMembers.organisationId, id));
  return c.json({ members: rows });
});
const memberBody = z.strictObject({ email: z.email().max(254), role: z.enum(["owner", "admin", "member", "finance_approver", "procurement_officer", "project_manager", "auditor"]) });
orgRoutes.post("/:id/members", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(memberBody, raw);
  return runIdempotent(c, { scope: "orgs.add_member", userId, body: { id, raw } }, async (tx) => {
    await requireOrgMember(tx, id, userId, ADMINS);
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, b.email.toLowerCase())).limit(1);
    if (!u) throw new ApiError(404, "user_not_found", "No account uses that email address yet");
    await tx.insert(organisationMembers).values({ organisationId: id, userId: u.id, role: b.role }).onConflictDoNothing();
    await notify(tx, [u.id], "org.member_added", { organisationId: id, role: b.role }, userId);
    return { status: 201, body: { member: { userId: u.id, role: b.role } } };
  });
});

// ── departments, cost centres, sites ─────────────────────────────────────────
orgRoutes.get("/:id/structure", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  await requireOrgMember(db, id, userId);
  return c.json({
    departments: await db.select().from(orgDepartments).where(eq(orgDepartments.organisationId, id)).orderBy(asc(orgDepartments.name)),
    costCentres: await db.select().from(costCentres).where(eq(costCentres.organisationId, id)).orderBy(asc(costCentres.code)),
    sites: await db.select().from(orgSites).where(eq(orgSites.organisationId, id)).orderBy(asc(orgSites.name)),
  });
});
orgRoutes.post("/:id/departments", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ name: z.string().trim().min(1).max(120) }), raw);
  return runIdempotent(c, { scope: "orgs.department", userId, body: { id, raw } }, async (tx) => {
    await requireOrgMember(tx, id, userId, ADMINS);
    const [r] = await tx.insert(orgDepartments).values({ organisationId: id, name: b.name }).onConflictDoNothing().returning({ id: orgDepartments.id });
    if (!r) throw new ApiError(409, "exists", "A department with this name already exists");
    return { status: 201, body: { department: { id: r.id, name: b.name } } };
  });
});
orgRoutes.post("/:id/cost-centres", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(120), departmentId: z.uuid().optional() }), raw);
  return runIdempotent(c, { scope: "orgs.cost_centre", userId, body: { id, raw } }, async (tx) => {
    await requireOrgMember(tx, id, userId, ADMINS);
    const [r] = await tx.insert(costCentres).values({ organisationId: id, code: b.code, name: b.name, departmentId: b.departmentId ?? null }).onConflictDoNothing().returning({ id: costCentres.id });
    if (!r) throw new ApiError(409, "exists", "A cost centre with this code already exists");
    return { status: 201, body: { costCentre: { id: r.id } } };
  });
});
const siteBody = z.strictObject({
  name: z.string().trim().min(1).max(160), departmentId: z.uuid().optional(), regionRef: z.string().trim().max(120).optional(),
  timezone: z.string().trim().max(64).optional(), address: z.record(z.string(), z.unknown()).default({}),
});
orgRoutes.post("/:id/sites", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(siteBody, raw);
  return runIdempotent(c, { scope: "orgs.site", userId, body: { id, raw } }, async (tx) => {
    await requireOrgMember(tx, id, userId, ADMINS);
    const [r] = await tx.insert(orgSites).values({ organisationId: id, name: b.name, departmentId: b.departmentId ?? null, regionRef: b.regionRef ?? null, timezone: b.timezone ?? null, address: b.address }).onConflictDoNothing().returning({ id: orgSites.id });
    if (!r) throw new ApiError(409, "exists", "A site with this name already exists");
    return { status: 201, body: { site: { id: r.id, name: b.name } } };
  });
});

// ── budgets (PRD §56, §116): limit, committed and paid are shown separately ──
const budgetBody = z.strictObject({
  label: z.string().trim().min(1).max(160), currency: z.string().trim().length(3), amountMinor: z.int().min(0),
  spendLimitMinor: z.int().min(0).optional(), periodStart: z.iso.date(), periodEnd: z.iso.date(),
  departmentId: z.uuid().optional(), costCentreId: z.uuid().optional(),
});
orgRoutes.post("/:id/budgets", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(budgetBody, raw);
  if (b.periodEnd < b.periodStart) throw new ApiError(400, "invalid_period", "periodEnd must not be before periodStart");
  return runIdempotent(c, { scope: "orgs.budget", userId, body: { id, raw } }, async (tx) => {
    await requireOrgMember(tx, id, userId, FINANCE);
    const [cur] = await tx.select({ c: currencies.code }).from(currencies).where(eq(currencies.code, b.currency)).limit(1);
    if (!cur) throw new ApiError(400, "unknown_currency", "Unknown currency");
    const [r] = await tx.insert(orgBudgets).values({ organisationId: id, label: b.label, currency: b.currency, amountMinor: b.amountMinor, spendLimitMinor: b.spendLimitMinor ?? null, periodStart: b.periodStart, periodEnd: b.periodEnd, departmentId: b.departmentId ?? null, costCentreId: b.costCentreId ?? null }).returning({ id: orgBudgets.id });
    return { status: 201, body: { budget: { id: r.id } } };
  });
});
orgRoutes.get("/:id/budgets", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  await requireOrgMember(db, id, userId);
  const rows = await db.select().from(orgBudgets).where(eq(orgBudgets.organisationId, id)).orderBy(desc(orgBudgets.periodStart));
  const out = [];
  for (const b of rows) {
    const committed = await db.select({ n: sql<number>`coalesce(sum(${projectBudgets.approvedMinor}),0)::bigint` }).from(projectBudgets).innerJoin(projects, eq(projects.id, projectBudgets.projectId))
      .where(and(eq(projects.organisationId, id), eq(projectBudgets.currency, b.currency), sql`${projects.createdAt}::date between ${b.periodStart} and ${b.periodEnd}`));
    const paid = await db.select({ n: sql<number>`coalesce(sum(${milestones.amountMinor}),0)::bigint` }).from(milestones).innerJoin(projects, eq(projects.id, milestones.projectId))
      .where(and(eq(projects.organisationId, id), eq(milestones.currency, b.currency), eq(milestones.status, "released"), sql`${projects.createdAt}::date between ${b.periodStart} and ${b.periodEnd}`));
    const committedMinor = Number(committed[0]?.n ?? 0);
    const paidMinor = Number(paid[0]?.n ?? 0);
    out.push({ ...b, committedMinor, paidMinor, remainingMinor: b.amountMinor - committedMinor, basis: "Committed is the sum of approved project budgets in the period. Paid is released milestones." });
  }
  return c.json({ budgets: out });
});

// ── approval chains (PRD §115) ───────────────────────────────────────────────
const policyBody = z.strictObject({
  subjectType: z.enum(["quote", "project", "change", "procurement", "payment", "milestone"]), thresholdMinor: z.int().min(0), currency: z.string().trim().length(3),
  requiredRole: z.enum(["owner", "admin", "finance_approver", "procurement_officer", "project_manager"]).default("finance_approver"),
});
orgRoutes.post("/:id/approval-policies", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(policyBody, raw);
  return runIdempotent(c, { scope: "orgs.policy", userId, body: { id, raw } }, async (tx) => {
    await requireOrgMember(tx, id, userId, ADMINS);
    const [r] = await tx.insert(approvalPolicies).values({ organisationId: id, subjectType: b.subjectType, thresholdMinor: b.thresholdMinor, currency: b.currency, requiredRole: b.requiredRole }).returning({ id: approvalPolicies.id });
    return { status: 201, body: { policy: { id: r.id } } };
  });
});
orgRoutes.get("/:id/approval-policies", async (c) => {
  const id = uuidParam(c.req.param("id"));
  await requireOrgMember(db, id, c.get("auth").userId);
  return c.json({ policies: await db.select().from(approvalPolicies).where(eq(approvalPolicies.organisationId, id)).orderBy(asc(approvalPolicies.subjectType), asc(approvalPolicies.thresholdMinor)) });
});

/** The gate other flows call. Returns the policy that applies (highest threshold the amount meets), or null when none does. */
export async function requiresApproval(ex: Executor, organisationId: string, subjectType: string, amountMinor: number, currency: string) {
  const rows = await ex.select().from(approvalPolicies).where(and(eq(approvalPolicies.organisationId, organisationId), eq(approvalPolicies.subjectType, subjectType), eq(approvalPolicies.currency, currency), eq(approvalPolicies.isActive, true)));
  const hit = rows.filter((p) => amountMinor >= p.thresholdMinor).sort((a, b) => b.thresholdMinor - a.thresholdMinor)[0];
  return hit ?? null;
}

const reqBody = z.strictObject({ subjectType: z.enum(["quote", "project", "change", "procurement", "payment", "milestone"]), subjectId: z.uuid(), projectId: z.uuid().optional(), amountMinor: z.int().min(0), currency: z.string().trim().length(3), note: z.string().trim().max(1000).optional() });
orgRoutes.post("/:id/approval-requests", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(reqBody, raw);
  return runIdempotent(c, { scope: "orgs.approval_request", userId, body: { id, raw } }, async (tx) => {
    await requireOrgMember(tx, id, userId);
    const policy = await requiresApproval(tx, id, b.subjectType, b.amountMinor, b.currency);
    const status = policy ? "pending" : "not_required";
    const [r] = await tx.insert(approvalRequests).values({ organisationId: id, subjectType: b.subjectType, subjectId: b.subjectId, projectId: b.projectId ?? null, requestedByUserId: userId, amountMinor: b.amountMinor, currency: b.currency, requiredRole: policy?.requiredRole ?? null, status, note: b.note ?? null }).returning({ id: approvalRequests.id });
    if (policy) {
      const approvers = await tx.select({ uid: organisationMembers.userId }).from(organisationMembers).where(and(eq(organisationMembers.organisationId, id), inArray(organisationMembers.role, [policy.requiredRole, "owner"])));
      await notify(tx, [...new Set(approvers.map((a) => a.uid))], "approval.requested", { organisationId: id, approvalRequestId: r.id, subjectType: b.subjectType }, userId);
    }
    return { status: 201, body: { approval: { id: r.id, status, requiredRole: policy?.requiredRole ?? null } } };
  });
});
orgRoutes.get("/:id/approval-requests", async (c) => {
  const id = uuidParam(c.req.param("id"));
  const userId = c.get("auth").userId;
  const roles = await requireOrgMember(db, id, userId);
  const status = c.req.query("status");
  const rows = await db.select().from(approvalRequests).where(and(eq(approvalRequests.organisationId, id), status ? eq(approvalRequests.status, status) : sql`true`)).orderBy(desc(approvalRequests.createdAt)).limit(200);
  const canSee = roles.some((r) => ["owner", "admin", "finance_approver", "procurement_officer", "auditor"].includes(r));
  return c.json({ approvals: rows.filter((r) => canSee || r.requestedByUserId === userId) });
});
export const approvalRoutes = new Hono<AuthEnv>();
approvalRoutes.use("*", requireAuth);
approvalRoutes.post("/:id/decide", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const b = parseOrThrow(z.strictObject({ decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).optional() }), await readJson(c));
  return runIdempotent(c, { scope: "approvals.decide", userId, body: { id, b } }, async (tx) => {
    const [r] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1).for("update");
    if (!r) throw notFound();
    const allowed: OrgRole[] = ["owner", ...(r.requiredRole ? [r.requiredRole as OrgRole] : [])];
    await requireOrgMember(tx, r.organisationId, userId, allowed);
    if (r.requestedByUserId === userId) throw new ApiError(403, "self_approval", "You cannot approve your own request");
    if (r.status !== "pending") throw new ApiError(409, "not_pending", `A ${r.status} request cannot be decided`);
    await tx.update(approvalRequests).set({ status: b.decision, decidedByUserId: userId, decidedAt: new Date(), note: b.note ?? r.note }).where(eq(approvalRequests.id, id));
    await notify(tx, [r.requestedByUserId], `approval.${b.decision}`, { approvalRequestId: id, subjectType: r.subjectType, subjectId: r.subjectId }, userId);
    return { status: 200, body: { approval: { id, status: b.decision } } };
  });
});
// A flow asks: is this subject cleared? (never mutates)
approvalRoutes.get("/status", async (c) => {
  const subjectType = c.req.query("subjectType");
  const subjectId = c.req.query("subjectId");
  if (!subjectType || !subjectId) throw new ApiError(400, "invalid_query", "subjectType and subjectId are required");
  const rows = await db.select({ status: approvalRequests.status, organisationId: approvalRequests.organisationId }).from(approvalRequests).where(and(eq(approvalRequests.subjectType, subjectType), eq(approvalRequests.subjectId, uuidParam(subjectId)))).orderBy(desc(approvalRequests.createdAt)).limit(1);
  const r = rows[0];
  return c.json({ cleared: !r || r.status === "approved" || r.status === "not_required", status: r?.status ?? null });
});

// ── preferred providers (PRD §7) ─────────────────────────────────────────────
orgRoutes.get("/:id/preferred-providers", async (c) => {
  const id = uuidParam(c.req.param("id"));
  await requireOrgMember(db, id, c.get("auth").userId);
  const rows = await db.select({ providerId: orgPreferredProviders.providerProfileId, categoryKey: orgPreferredProviders.categoryKey, note: orgPreferredProviders.note, name: providerProfiles.displayName, headline: providerProfiles.headline })
    .from(orgPreferredProviders).innerJoin(providerProfiles, eq(providerProfiles.id, orgPreferredProviders.providerProfileId)).where(eq(orgPreferredProviders.organisationId, id));
  return c.json({ providers: rows });
});
orgRoutes.post("/:id/preferred-providers", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ providerProfileId: z.uuid(), categoryKey: z.string().trim().max(120).default(""), note: z.string().trim().max(500).optional() }), raw);
  return runIdempotent(c, { scope: "orgs.preferred", userId, body: { id, raw } }, async (tx) => {
    await requireOrgMember(tx, id, userId, [...ADMINS, "procurement_officer", "project_manager"]);
    const [p] = await tx.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.id, b.providerProfileId)).limit(1);
    if (!p) throw notFound();
    await tx.insert(orgPreferredProviders).values({ organisationId: id, providerProfileId: b.providerProfileId, categoryKey: b.categoryKey, note: b.note ?? null }).onConflictDoNothing();
    return { status: 201, body: { preferred: { providerProfileId: b.providerProfileId, categoryKey: b.categoryKey } } };
  });
});

// ── SLAs (PRD §76) ───────────────────────────────────────────────────────────
const slaBody = z.strictObject({
  categoryKey: z.string().trim().max(120).optional(), responseMinutes: z.int().min(1).optional(), arrivalMinutes: z.int().min(1).optional(),
  resolutionMinutes: z.int().min(1).optional(), completionHours: z.int().min(1).optional(),
  escalation: z.array(z.strictObject({ afterMinutes: z.int().min(1), notifyRole: z.string().trim().max(40) })).max(10).default([]),
});
orgRoutes.post("/:id/sla-policies", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(slaBody, raw);
  return runIdempotent(c, { scope: "orgs.sla", userId, body: { id, raw } }, async (tx) => {
    await requireOrgMember(tx, id, userId, ADMINS);
    const [r] = await tx.insert(slaPolicies).values({ organisationId: id, categoryKey: b.categoryKey ?? null, responseMinutes: b.responseMinutes ?? null, arrivalMinutes: b.arrivalMinutes ?? null, resolutionMinutes: b.resolutionMinutes ?? null, completionHours: b.completionHours ?? null, escalation: b.escalation }).returning({ id: slaPolicies.id });
    return { status: 201, body: { sla: { id: r.id } } };
  });
});

/** Measures what the recorded data can measure: first-quote time after invitation, arrival vs booking start, planned vs actual end. */
orgRoutes.get("/:id/sla-report", async (c) => {
  const id = uuidParam(c.req.param("id"));
  await requireOrgMember(db, id, c.get("auth").userId, [...ADMINS, "auditor", "project_manager", "finance_approver"]);
  const pols = await db.select().from(slaPolicies).where(and(eq(slaPolicies.organisationId, id), eq(slaPolicies.isActive, true)));
  const limitResponse = Math.min(...pols.map((p) => p.responseMinutes ?? Infinity));
  const limitArrival = Math.min(...pols.map((p) => p.arrivalMinutes ?? Infinity));
  const limitCompletion = Math.min(...pols.map((p) => p.completionHours ?? Infinity));

  const resp = await db.select({ invited: taskInvitations.createdAt, quoted: sql<Date | null>`min(${quotes.createdAt})`, provider: providerProfiles.displayName })
    .from(taskInvitations).innerJoin(tasks, eq(tasks.id, taskInvitations.taskId)).innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(providerProfiles, eq(providerProfiles.id, taskInvitations.providerProfileId))
    .leftJoin(quotes, and(eq(quotes.taskId, taskInvitations.taskId), eq(quotes.providerProfileId, taskInvitations.providerProfileId)))
    .where(eq(projects.organisationId, id)).groupBy(taskInvitations.taskId, taskInvitations.providerProfileId, taskInvitations.createdAt, providerProfiles.displayName).limit(500);
  const responseMins = resp.filter((r) => r.quoted).map((r) => ({ provider: r.provider, minutes: Math.round((new Date(r.quoted as Date).getTime() - r.invited.getTime()) / 60000) }));

  const arr = await db.select({ start: bookings.startsAt, arrived: sql<Date | null>`min(${checkIns.createdAt})`, provider: providerProfiles.displayName })
    .from(bookings).innerJoin(projects, eq(projects.id, bookings.projectId)).innerJoin(providerProfiles, eq(providerProfiles.id, bookings.providerProfileId))
    .leftJoin(checkIns, and(eq(checkIns.taskId, bookings.taskId), eq(checkIns.kind, "arrived")))
    .where(and(eq(projects.organisationId, id), eq(bookings.status, "confirmed"))).groupBy(bookings.id, bookings.startsAt, providerProfiles.displayName).limit(500);
  const lateMins = arr.filter((r) => r.arrived).map((r) => ({ provider: r.provider, minutesLate: Math.round((new Date(r.arrived as Date).getTime() - r.start.getTime()) / 60000) }));

  const done = await db.select({ plannedEnd: tasks.plannedEnd, actualEnd: tasks.actualEnd, actualStart: tasks.actualStart }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(projects.organisationId, id), sql`${tasks.actualEnd} is not null`)).limit(1000);

  const breaches = {
    response: Number.isFinite(limitResponse) ? responseMins.filter((r) => r.minutes > limitResponse).length : null,
    arrival: Number.isFinite(limitArrival) ? lateMins.filter((r) => r.minutesLate > limitArrival).length : null,
    completion: Number.isFinite(limitCompletion) ? done.filter((t) => t.actualStart && t.actualEnd && (t.actualEnd.getTime() - t.actualStart.getTime()) / 3600000 > limitCompletion).length : null,
  };
  if ((breaches.response ?? 0) + (breaches.arrival ?? 0) + (breaches.completion ?? 0) > 0) await logEvent(db, "sla.breach", "warn", { organisationId: id, ...breaches });
  const lateOnPlan = done.filter((t) => t.plannedEnd && t.actualEnd && t.actualEnd.getTime() > t.plannedEnd.getTime()).length;
  return c.json({ report: { policies: pols.length, measured: { responses: responseMins.length, arrivals: lateMins.length, completedTasks: done.length }, breaches, completedLateAgainstPlan: lateOnPlan, note: "Only items with the needed timestamps are measured." } });
});

orgRoutes.get("/:id/overview", async (c) => {
  const id = uuidParam(c.req.param("id"));
  await requireOrgMember(db, id, c.get("auth").userId);
  const ps = await db.select({ id: projects.id, title: projects.title, status: projects.status, health: projects.health, currency: projects.currency, createdAt: projects.createdAt }).from(projects).where(eq(projects.organisationId, id)).orderBy(desc(projects.createdAt)).limit(200);
  const byCurrency: Record<string, number> = {};
  if (ps.length > 0) {
    const rows = await db.select({ cur: milestones.currency, n: sql<number>`coalesce(sum(${milestones.amountMinor}),0)::bigint` }).from(milestones).where(and(inArray(milestones.projectId, ps.map((p) => p.id)), eq(milestones.status, "released"))).groupBy(milestones.currency);
    for (const r of rows) byCurrency[r.cur] = Number(r.n);
  }
  return c.json({ projects: ps, paidByCurrencyMinor: byCurrency, note: "Totals are per currency. Currencies are never added together." });
});

