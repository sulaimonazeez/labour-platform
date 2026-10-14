import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  assignments, projectMembers, projects, providerProfiles, quoteLineItems, quoteLineKind, quoteVersions,
  quotes, taskInvitations, tasks,
} from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { getProjectRoles, PROJECT_MANAGERS, requireProjectRole } from "../authz/projects.js";
import type { Executor } from "../db/types.js";
import { computeQuoteAmounts, QUANTITY_RE, MAX_MINOR } from "../engine/quote-math.js";
import { canTransition, QUOTE_TRANSITIONS, TASK_TRANSITIONS, type QuoteStatus } from "../engine/state-machines.js";
import { recordActivity } from "../lib/activity.js";
import { managerUserIds, notify } from "../lib/notify.js";
import { runIdempotent } from "../lib/idempotency.js";
import { ApiError, parseOrThrow, pgErrorCode, readJson, uuidParam } from "./http.js";

// Invitations, quotes and quote acceptance (PRD §52-53, §95; DECISIONS D28-D33).
//   manager: POST /tasks/:id/invitations, GET /tasks/:id/quotes, request-revision / reject / accept
//   provider: POST /tasks/:id/quotes, PUT / revise / submit / withdraw
// Quotes are never overwritten: a submitted version is frozen by the database (sql/guards.sql section 3).

const LIVE: QuoteStatus[] = ["draft", "submitted", "revision_requested"];
// The platform fee is added by the platform (PRD §52 "where disclosed"), never typed in by a provider.
const QUOTABLE_KINDS = quoteLineKind.enumValues.filter((k) => k !== "platform_fee") as [string, ...string[]];

const quoteCols = {
  id: quotes.id,
  taskId: quotes.taskId,
  projectId: quotes.projectId,
  providerProfileId: quotes.providerProfileId,
  status: quotes.status,
  latestVersion: quotes.latestVersion,
  acceptedVersion: quotes.acceptedVersion,
  createdAt: quotes.createdAt,
  updatedAt: quotes.updatedAt,
};
const versionCols = {
  id: quoteVersions.id,
  version: quoteVersions.version,
  currency: quoteVersions.currency,
  totalMinor: quoteVersions.totalMinor,
  validUntil: quoteVersions.validUntil,
  inspectionRequired: quoteVersions.inspectionRequired,
  exclusions: quoteVersions.exclusions,
  notes: quoteVersions.notes,
  createdByUserId: quoteVersions.createdByUserId,
  submittedAt: quoteVersions.submittedAt,
  createdAt: quoteVersions.createdAt,
};
const lineCols = {
  id: quoteLineItems.id,
  kind: quoteLineItems.kind,
  description: quoteLineItems.description,
  quantity: quoteLineItems.quantity,
  unitPriceMinor: quoteLineItems.unitPriceMinor,
  amountMinor: quoteLineItems.amountMinor,
  isOptional: quoteLineItems.isOptional,
  position: quoteLineItems.position,
};

const quantitySchema = z
  .union([z.number(), z.string()])
  .transform((v) => String(v).trim())
  .refine((s) => QUANTITY_RE.test(s) && Number(s) > 0, "quantity must be above 0 with at most 3 decimals");

const lineBody = z.strictObject({
  kind: z.enum(QUOTABLE_KINDS),
  description: z.string().trim().min(1).max(500),
  quantity: quantitySchema.optional(),
  unitPriceMinor: z.int().min(0).max(MAX_MINOR),
  isOptional: z.boolean().optional(),
});

// The server computes every amount and the total; the client never sends them.
const contentBody = z.strictObject({
  currency: z.string().trim().toUpperCase().length(3),
  validUntil: z.iso.datetime({ offset: true }).optional(),
  inspectionRequired: z.boolean().optional(),
  exclusions: z.string().trim().min(1).max(3000).optional(),
  notes: z.string().trim().min(1).max(3000).optional(),
  lines: z.array(lineBody).min(1).max(100),
});
type Content = z.output<typeof contentBody>;

const emptyBody = z.strictObject({});
const reasonBody = z.strictObject({ reason: z.string().trim().min(1).max(1000).optional() });
const inviteBody = z.strictObject({ providerProfileId: z.uuid() });

// ---- helpers -------------------------------------------------------------------------------------

function price(b: Content) {
  const lines = b.lines.map((l) => ({
    kind: l.kind as (typeof quoteLineKind.enumValues)[number],
    description: l.description,
    quantity: l.quantity ?? "1",
    unitPriceMinor: l.unitPriceMinor,
    isOptional: l.isOptional ?? false,
  }));
  try {
    const { amounts, totalMinor } = computeQuoteAmounts(lines);
    return { lines: lines.map((l, i) => ({ ...l, amountMinor: amounts[i] })), totalMinor };
  } catch (e) {
    if (e instanceof RangeError) throw new ApiError(400, "amount_too_large", "A line amount or the total is too large");
    throw e;
  }
}

async function insertLines(ex: Executor, quoteVersionId: string, lines: ReturnType<typeof price>["lines"]) {
  await ex.insert(quoteLineItems).values(lines.map((l, i) => ({ quoteVersionId, ...l, position: i })));
}

async function loadQuote(ex: Executor, id: string, lock: boolean) {
  const base = ex.select(quoteCols).from(quotes).where(eq(quotes.id, id)).limit(1);
  const rows = lock ? await base.for("update") : await base;
  const row = rows[0];
  if (!row || !row.taskId || !row.projectId) throw new ApiError(404, "not_found", "Not found");
  return { ...row, taskId: row.taskId, projectId: row.projectId };
}
type QuoteRow = Awaited<ReturnType<typeof loadQuote>>;

/**
 * Who is calling, relative to this quote. A caller who is neither the quoting provider nor a member of
 * the project gets 404 (no existence leak, D21).
 */
async function partyOf(ex: Executor, q: QuoteRow, userId: string) {
  const [prof] = await ex.select({ userId: providerProfiles.userId }).from(providerProfiles).where(eq(providerProfiles.id, q.providerProfileId)).limit(1);
  const isProvider = prof?.userId === userId;
  const roles = await getProjectRoles(ex, q.projectId, userId);
  if (!isProvider && roles.length === 0) throw new ApiError(404, "not_found", "Not found");
  const isManager = roles.some((r) => PROJECT_MANAGERS.includes(r));
  return { isProvider, isManager };
}
type Party = Awaited<ReturnType<typeof partyOf>>;
const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do this");
function needProvider(p: Party) { if (!p.isProvider) throw forbidden(); }
function needManager(p: Party) { if (!p.isManager) throw forbidden(); }

function needTransition(from: QuoteStatus, to: QuoteStatus) {
  if (!canTransition(QUOTE_TRANSITIONS, from, to)) {
    throw new ApiError(409, "illegal_transition", `A ${from} quote cannot move to ${to}`, { from, to, allowed: QUOTE_TRANSITIONS[from] });
  }
}

async function latestVersionRow(ex: Executor, quoteId: string, version: number) {
  const [v] = await ex.select(versionCols).from(quoteVersions).where(and(eq(quoteVersions.quoteId, quoteId), eq(quoteVersions.version, version))).limit(1);
  if (!v) throw new ApiError(500, "internal", "Quote version missing");
  return v;
}

async function taskIsOffered(ex: Executor, taskId: string) {
  const [t] = await ex.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) throw new ApiError(404, "not_found", "Not found");
  if (t.status !== "offered") {
    throw new ApiError(409, "task_not_open_for_quotes", "This task is no longer open for quotes", { taskStatus: t.status });
  }
}

async function projectOpen(ex: Executor, projectId: string) {
  const [p] = await ex.select({ status: projects.status, currency: projects.currency, ownerUserId: projects.ownerUserId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) throw new ApiError(404, "not_found", "Not found");
  if (p.status !== "draft" && p.status !== "active") {
    throw new ApiError(409, "project_not_open", `A ${p.status} project cannot take quotes or awards`);
  }
  return p;
}

function needCurrency(b: Content, projectCurrency: string) {
  // One currency per project for now; cross-currency quotes need the FX flow (PRD §46), see D30.
  if (b.currency !== projectCurrency) {
    throw new ApiError(400, "currency_mismatch", "Quote currency must equal the project currency", { projectCurrency });
  }
}

// ---- manager side, mounted on /tasks ---------------------------------------------------------------

export const taskQuoteRoutes = new Hono<AuthEnv>();
taskQuoteRoutes.use("*", requireAuth);

// Invite a provider to quote. The first invitation offers the task (ready -> offered); D28.
taskQuoteRoutes.post("/:id/invitations", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(inviteBody, raw);

  return runIdempotent(c, { scope: "tasks.invite_provider", userId, body: raw }, async (tx) => {
    const [t] = await tx.select({ id: tasks.id, projectId: tasks.projectId, status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1).for("update");
    if (!t) throw new ApiError(404, "not_found", "Not found");
    await requireProjectRole(tx, t.projectId, userId, PROJECT_MANAGERS);
    const project = await projectOpen(tx, t.projectId);

    if (t.status !== "ready" && t.status !== "offered") {
      throw new ApiError(409, "task_not_offerable", "Only a ready or already-offered task can take invitations", { taskStatus: t.status });
    }

    const [prov] = await tx
      .select({ id: providerProfiles.id, userId: providerProfiles.userId })
      .from(providerProfiles)
      .where(and(eq(providerProfiles.id, b.providerProfileId), eq(providerProfiles.isActive, true)))
      .limit(1);
    // Same answer for "no such provider" and "inactive provider".
    if (!prov) throw new ApiError(400, "provider_invalid", "providerProfileId is not an active provider");
    const provRoles = await getProjectRoles(tx, t.projectId, prov.userId);
    if (prov.userId === project.ownerUserId || provRoles.some((r) => PROJECT_MANAGERS.includes(r))) {
      throw new ApiError(400, "provider_conflict", "A project owner or manager cannot be invited to quote on their own project");
    }

    const [dup] = await tx
      .select({ status: taskInvitations.status })
      .from(taskInvitations)
      .where(and(eq(taskInvitations.taskId, taskId), eq(taskInvitations.providerProfileId, prov.id)))
      .limit(1);
    if (dup) throw new ApiError(409, "invitation_exists", "This provider is already invited to this task");

    await tx.insert(taskInvitations).values({ taskId, providerProfileId: prov.id, invitedByUserId: userId });
    await recordActivity(tx, {
      projectId: t.projectId,
      actorUserId: userId,
      eventType: "task.provider_invited",
      subjectType: "task",
      subjectId: taskId,
      payload: { providerProfileId: prov.id },
    });
    await notify(tx, [prov.userId], "task.invited", { projectId: t.projectId, taskId }, userId);

    let status = t.status;
    if (t.status === "ready") {
      if (!canTransition(TASK_TRANSITIONS, "ready", "offered")) throw new ApiError(500, "internal", "ready -> offered must be legal");
      await tx.update(tasks).set({ status: "offered" }).where(eq(tasks.id, taskId));
      await recordActivity(tx, {
        projectId: t.projectId,
        actorUserId: userId,
        eventType: "task.transitioned",
        subjectType: "task",
        subjectId: taskId,
        payload: { from: "ready", to: "offered", via: "invitation" },
      });
      status = "offered";
    }
    return {
      status: 201,
      body: { invitation: { taskId, providerProfileId: prov.id, status: "invited" }, task: { id: taskId, status } },
    };
  });
});

// Managers see every quote that has a submitted version. A provider sees only their own, and only if invited.
taskQuoteRoutes.get("/:id/quotes", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const [t] = await db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) throw new ApiError(404, "not_found", "Not found");

  const roles = await getProjectRoles(db, t.projectId, userId);
  const isManager = roles.some((r) => PROJECT_MANAGERS.includes(r));
  let providerId: string | null = null;
  if (!isManager) {
    const [prof] = await db.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
    const [inv] = prof
      ? await db.select({ s: taskInvitations.status }).from(taskInvitations).where(and(eq(taskInvitations.taskId, taskId), eq(taskInvitations.providerProfileId, prof.id))).limit(1)
      : [];
    if (!prof || !inv) {
      if (roles.length > 0) throw forbidden();
      throw new ApiError(404, "not_found", "Not found");
    }
    providerId = prof.id;
  }

  const rows = await db
    .select({ ...quoteCols, providerName: providerProfiles.displayName })
    .from(quotes)
    .innerJoin(providerProfiles, eq(providerProfiles.id, quotes.providerProfileId))
    .where(providerId ? and(eq(quotes.taskId, taskId), eq(quotes.providerProfileId, providerId)) : eq(quotes.taskId, taskId))
    .orderBy(desc(quotes.createdAt));
  const ids = rows.map((r) => r.id);
  const versions = ids.length === 0 ? [] : await db.select({ quoteId: quoteVersions.quoteId, ...versionCols }).from(quoteVersions).where(inArray(quoteVersions.quoteId, ids)).orderBy(desc(quoteVersions.version));

  const out = rows
    .map((r) => {
      const mine = versions.filter((v) => v.quoteId === r.id && (providerId !== null || v.submittedAt !== null));
      const { quoteId: _q, ...latest } = mine[0] ?? ({} as (typeof versions)[number]);
      return { ...r, latest: mine.length > 0 ? latest : null };
    })
    // Managers never see a quote that has no submitted version (the provider's private draft).
    .filter((r) => providerId !== null || r.latest !== null);
  return c.json({ quotes: out });
});

// A provider creates version 1 (draft) of a quote on a task they were invited to.
taskQuoteRoutes.post("/:id/quotes", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(contentBody, raw);
  const priced = price(b);

  return runIdempotent(c, { scope: "quotes.create", userId, body: raw }, async (tx) => {
    const [prof] = await tx.select({ id: providerProfiles.id }).from(providerProfiles).where(and(eq(providerProfiles.userId, userId), eq(providerProfiles.isActive, true))).limit(1);
    if (!prof) throw new ApiError(403, "provider_profile_required", "Create a provider profile first");

    // Lock the invitation row: it serialises two concurrent creates by the same provider for one task.
    const [inv] = await tx
      .select({ status: taskInvitations.status })
      .from(taskInvitations)
      .where(and(eq(taskInvitations.taskId, taskId), eq(taskInvitations.providerProfileId, prof.id)))
      .limit(1)
      .for("update");
    if (!inv) throw new ApiError(404, "not_found", "Not found"); // not invited = task does not exist for you
    if (inv.status === "declined" || inv.status === "expired") {
      throw new ApiError(409, "invitation_closed", "This invitation is no longer open");
    }

    const [t] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!t) throw new ApiError(404, "not_found", "Not found");
    await taskIsOffered(tx, taskId);
    const project = await projectOpen(tx, t.projectId);
    needCurrency(b, project.currency);

    const [live] = await tx
      .select({ id: quotes.id })
      .from(quotes)
      .where(and(eq(quotes.taskId, taskId), eq(quotes.providerProfileId, prof.id), inArray(quotes.status, LIVE)))
      .limit(1);
    if (live) throw new ApiError(409, "quote_exists", "You already have an open quote on this task", { quoteId: live.id });

    const [q] = await tx
      .insert(quotes)
      .values({ taskId, projectId: t.projectId, providerProfileId: prof.id, status: "draft", latestVersion: 1 })
      .returning(quoteCols);
    const [v] = await tx
      .insert(quoteVersions)
      .values({
        quoteId: q.id,
        version: 1,
        currency: b.currency,
        totalMinor: priced.totalMinor,
        validUntil: b.validUntil ? new Date(b.validUntil) : null,
        inspectionRequired: b.inspectionRequired ?? false,
        exclusions: b.exclusions ?? null,
        notes: b.notes ?? null,
        createdByUserId: userId,
      })
      .returning(versionCols);
    await insertLines(tx, v.id, priced.lines);
    await recordActivity(tx, {
      projectId: t.projectId,
      actorUserId: userId,
      eventType: "quote.created",
      subjectType: "quote",
      subjectId: q.id,
      payload: { taskId, version: 1, currency: b.currency, totalMinor: priced.totalMinor },
    });
    const lines = await tx.select(lineCols).from(quoteLineItems).where(eq(quoteLineItems.quoteVersionId, v.id)).orderBy(asc(quoteLineItems.position));
    return { status: 201, body: { quote: q, version: v, lines } };
  });
});

// ---- quote routes, mounted on /quotes ----------------------------------------------------------------

export const quoteRoutes = new Hono<AuthEnv>();
quoteRoutes.use("*", requireAuth);

quoteRoutes.get("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const q = await loadQuote(db, id, false);
  const party = await partyOf(db, q, userId);
  if (!party.isProvider && !party.isManager) throw forbidden();

  const all = await db.select(versionCols).from(quoteVersions).where(eq(quoteVersions.quoteId, id)).orderBy(asc(quoteVersions.version));
  // Unsubmitted versions are the provider's private working copy.
  const visible = party.isProvider ? all : all.filter((v) => v.submittedAt !== null);
  if (visible.length === 0) throw new ApiError(404, "not_found", "Not found");

  const wanted = c.req.query("version");
  let chosen = visible[visible.length - 1];
  if (wanted !== undefined) {
    const n = Number(wanted);
    const hit = Number.isInteger(n) ? visible.find((v) => v.version === n) : undefined;
    if (!hit) throw new ApiError(404, "not_found", "Not found");
    chosen = hit;
  }
  const lines = await db.select(lineCols).from(quoteLineItems).where(eq(quoteLineItems.quoteVersionId, chosen.id)).orderBy(asc(quoteLineItems.position));
  return c.json({ quote: q, versions: visible, version: chosen, lines });
});

// Provider edits their unsubmitted draft (replaces the draft version's content entirely).
quoteRoutes.put("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(contentBody, raw);
  const priced = price(b);

  return runIdempotent(c, { scope: "quotes.edit_draft", userId, body: raw }, async (tx) => {
    const q = await loadQuote(tx, id, true);
    needProvider(await partyOf(tx, q, userId));
    if (q.status !== "draft") throw new ApiError(409, "quote_not_editable", "Only a draft quote can be edited; a submitted version is frozen", { status: q.status });
    await taskIsOffered(tx, q.taskId);
    const project = await projectOpen(tx, q.projectId);
    needCurrency(b, project.currency);

    const cur = await latestVersionRow(tx, id, q.latestVersion);
    if (cur.submittedAt) throw new ApiError(409, "quote_not_editable", "This version is already submitted");
    const [v] = await tx
      .update(quoteVersions)
      .set({
        currency: b.currency,
        totalMinor: priced.totalMinor,
        validUntil: b.validUntil ? new Date(b.validUntil) : null,
        inspectionRequired: b.inspectionRequired ?? false,
        exclusions: b.exclusions ?? null,
        notes: b.notes ?? null,
      })
      .where(eq(quoteVersions.id, cur.id))
      .returning(versionCols);
    await tx.delete(quoteLineItems).where(eq(quoteLineItems.quoteVersionId, cur.id));
    await insertLines(tx, cur.id, priced.lines);
    const [updated] = await tx.update(quotes).set({ updatedAt: new Date() }).where(eq(quotes.id, id)).returning(quoteCols);
    await recordActivity(tx, {
      projectId: q.projectId,
      actorUserId: userId,
      eventType: "quote.draft_edited",
      subjectType: "quote",
      subjectId: id,
      payload: { version: q.latestVersion, totalMinor: priced.totalMinor },
    });
    const lines = await tx.select(lineCols).from(quoteLineItems).where(eq(quoteLineItems.quoteVersionId, cur.id)).orderBy(asc(quoteLineItems.position));
    return { status: 200, body: { quote: updated, version: v, lines } };
  });
});

// Submit: the latest version gets submitted_at, which freezes it in the database.
quoteRoutes.post("/:id/submit", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  parseOrThrow(emptyBody, raw ?? {});

  return runIdempotent(c, { scope: "quotes.submit", userId, body: raw }, async (tx) => {
    const q = await loadQuote(tx, id, true);
    needProvider(await partyOf(tx, q, userId));
    needTransition(q.status, "submitted");
    await taskIsOffered(tx, q.taskId);

    const cur = await latestVersionRow(tx, id, q.latestVersion);
    if (cur.validUntil && cur.validUntil.getTime() <= Date.now()) {
      throw new ApiError(400, "valid_until_past", "validUntil is already in the past; edit the draft first");
    }
    const [v] = await tx.update(quoteVersions).set({ submittedAt: new Date() }).where(eq(quoteVersions.id, cur.id)).returning(versionCols);
    const [updated] = await tx.update(quotes).set({ status: "submitted" }).where(eq(quotes.id, id)).returning(quoteCols);
    await tx
      .update(taskInvitations)
      .set({ status: "quoted" })
      .where(and(eq(taskInvitations.taskId, q.taskId), eq(taskInvitations.providerProfileId, q.providerProfileId), inArray(taskInvitations.status, ["invited", "viewed", "interested", "negotiating"])));
    await recordActivity(tx, {
      projectId: q.projectId,
      actorUserId: userId,
      eventType: "quote.submitted",
      subjectType: "quote",
      subjectId: id,
      payload: { version: v.version, currency: v.currency, totalMinor: v.totalMinor },
    });
    await notify(tx, await managerUserIds(tx, q.projectId), "quote.submitted", { projectId: q.projectId, taskId: q.taskId, quoteId: id }, userId);
    return { status: 200, body: { quote: updated, version: v } };
  });
});

// Manager asks for changes: the submitted version stays as it was; the provider writes the next one.
quoteRoutes.post("/:id/request-revision", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(reasonBody, raw ?? {});

  return runIdempotent(c, { scope: "quotes.request_revision", userId, body: raw }, async (tx) => {
    const q = await loadQuote(tx, id, true);
    needManager(await partyOf(tx, q, userId));
    needTransition(q.status, "revision_requested");
    const [updated] = await tx.update(quotes).set({ status: "revision_requested" }).where(eq(quotes.id, id)).returning(quoteCols);
    await recordActivity(tx, {
      projectId: q.projectId,
      actorUserId: userId,
      eventType: "quote.revision_requested",
      subjectType: "quote",
      subjectId: id,
      payload: { version: q.latestVersion, ...(b.reason ? { reason: b.reason } : {}) },
    });
    return { status: 200, body: { quote: updated } };
  });
});

// Provider answers a revision request: copy the latest version into a new draft version (PRD §53).
quoteRoutes.post("/:id/revise", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  parseOrThrow(emptyBody, raw ?? {});

  return runIdempotent(c, { scope: "quotes.revise", userId, body: raw }, async (tx) => {
    const q = await loadQuote(tx, id, true);
    needProvider(await partyOf(tx, q, userId));
    needTransition(q.status, "draft");
    if (q.status !== "revision_requested") throw new ApiError(409, "illegal_transition", "Only a quote with a revision request can be revised");
    await taskIsOffered(tx, q.taskId);

    const prev = await latestVersionRow(tx, id, q.latestVersion);
    const prevLines = await tx.select(lineCols).from(quoteLineItems).where(eq(quoteLineItems.quoteVersionId, prev.id)).orderBy(asc(quoteLineItems.position));
    const next = q.latestVersion + 1;
    const [v] = await tx
      .insert(quoteVersions)
      .values({
        quoteId: id,
        version: next,
        currency: prev.currency,
        totalMinor: prev.totalMinor,
        validUntil: prev.validUntil,
        inspectionRequired: prev.inspectionRequired,
        exclusions: prev.exclusions,
        notes: prev.notes,
        createdByUserId: userId,
      })
      .returning(versionCols);
    await tx.insert(quoteLineItems).values(
      prevLines.map((l) => ({
        quoteVersionId: v.id, kind: l.kind, description: l.description, quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor, amountMinor: l.amountMinor, isOptional: l.isOptional, position: l.position,
      })),
    );
    const [updated] = await tx.update(quotes).set({ status: "draft", latestVersion: next }).where(eq(quotes.id, id)).returning(quoteCols);
    await recordActivity(tx, {
      projectId: q.projectId,
      actorUserId: userId,
      eventType: "quote.revised",
      subjectType: "quote",
      subjectId: id,
      payload: { version: next, basedOnVersion: q.latestVersion },
    });
    const lines = await tx.select(lineCols).from(quoteLineItems).where(eq(quoteLineItems.quoteVersionId, v.id)).orderBy(asc(quoteLineItems.position));
    return { status: 200, body: { quote: updated, version: v, lines } };
  });
});

quoteRoutes.post("/:id/withdraw", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(reasonBody, raw ?? {});

  return runIdempotent(c, { scope: "quotes.withdraw", userId, body: raw }, async (tx) => {
    const q = await loadQuote(tx, id, true);
    needProvider(await partyOf(tx, q, userId));
    needTransition(q.status, "withdrawn");
    const [updated] = await tx.update(quotes).set({ status: "withdrawn" }).where(eq(quotes.id, id)).returning(quoteCols);
    await recordActivity(tx, {
      projectId: q.projectId,
      actorUserId: userId,
      eventType: "quote.withdrawn",
      subjectType: "quote",
      subjectId: id,
      payload: { ...(b.reason ? { reason: b.reason } : {}) },
    });
    return { status: 200, body: { quote: updated } };
  });
});

quoteRoutes.post("/:id/reject", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(reasonBody, raw ?? {});

  return runIdempotent(c, { scope: "quotes.reject", userId, body: raw }, async (tx) => {
    const q = await loadQuote(tx, id, true);
    needManager(await partyOf(tx, q, userId));
    needTransition(q.status, "rejected");
    const [updated] = await tx.update(quotes).set({ status: "rejected" }).where(eq(quotes.id, id)).returning(quoteCols);
    await recordActivity(tx, {
      projectId: q.projectId,
      actorUserId: userId,
      eventType: "quote.rejected",
      subjectType: "quote",
      subjectId: id,
      payload: { ...(b.reason ? { reason: b.reason } : {}) },
    });
    return { status: 200, body: { quote: updated } };
  });
});

// Accept (PRD §61): ONE transaction awards the task. Quote -> accepted, an assignment is OFFERED to the
// provider, task offered -> assigned, the provider becomes a project member, competing quotes close.
quoteRoutes.post("/:id/accept", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  parseOrThrow(emptyBody, raw ?? {});

  return runIdempotent(c, { scope: "quotes.accept", userId, body: raw }, async (tx) => {
    const first = await loadQuote(tx, id, false);
    needManager(await partyOf(tx, first, userId));
    const { taskId, projectId } = first;

    // Lock order is always task, then quote(s): concurrent accepts on one task serialise here.
    const [task] = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1).for("update");
    if (!task) throw new ApiError(404, "not_found", "Not found");
    const q = await loadQuote(tx, id, true);
    await projectOpen(tx, projectId);
    if (task.status !== "offered") {
      throw new ApiError(409, "task_not_open_for_quotes", "This task is no longer open for quotes", { taskStatus: task.status });
    }
    needTransition(q.status, "accepted");
    if (!canTransition(TASK_TRANSITIONS, "offered", "assigned")) throw new ApiError(500, "internal", "offered -> assigned must be legal");

    const version = await latestVersionRow(tx, id, q.latestVersion);
    if (!version.submittedAt) throw new ApiError(409, "quote_not_submitted", "Only a submitted version can be accepted");
    if (version.validUntil && version.validUntil.getTime() <= Date.now()) {
      throw new ApiError(409, "quote_expired", "This quote has passed its validity date; ask for a revision", { validUntil: version.validUntil });
    }
    const [prov] = await tx.select({ id: providerProfiles.id, userId: providerProfiles.userId, isActive: providerProfiles.isActive }).from(providerProfiles).where(eq(providerProfiles.id, q.providerProfileId)).limit(1);
    if (!prov || !prov.isActive) throw new ApiError(409, "provider_inactive", "This provider is no longer active");

    const [accepted] = await tx.update(quotes).set({ status: "accepted", acceptedVersion: q.latestVersion }).where(eq(quotes.id, id)).returning(quoteCols);

    let assignment;
    try {
      [assignment] = await tx
        .insert(assignments)
        .values({ taskId, providerProfileId: prov.id, quoteId: id, status: "offered" })
        .returning({ id: assignments.id, taskId: assignments.taskId, providerProfileId: assignments.providerProfileId, quoteId: assignments.quoteId, status: assignments.status, offeredAt: assignments.offeredAt });
    } catch (e) {
      // The partial unique index (one live assignment per task) is the last line of defence.
      if (pgErrorCode(e) === "23505") throw new ApiError(409, "task_already_assigned", "This task already has a live assignment");
      throw e;
    }

    await tx.update(tasks).set({ status: "assigned" }).where(eq(tasks.id, taskId));
    await tx.insert(projectMembers).values({ projectId, userId: prov.userId, role: "provider" }).onConflictDoNothing();

    // Competing quotes on this task close: private drafts are withdrawn, everything else is rejected.
    const others = await tx
      .select({ id: quotes.id, status: quotes.status })
      .from(quotes)
      .where(and(eq(quotes.taskId, taskId), ne(quotes.id, id), inArray(quotes.status, LIVE)))
      .for("update");
    for (const o of others) {
      const to: QuoteStatus = o.status === "draft" ? "withdrawn" : "rejected";
      await tx.update(quotes).set({ status: to }).where(eq(quotes.id, o.id));
      await recordActivity(tx, {
        projectId, actorUserId: userId, eventType: `quote.${to}`, subjectType: "quote", subjectId: o.id,
        payload: { reason: "task_awarded" },
      });
    }
    await tx.update(taskInvitations).set({ status: "assigned" }).where(and(eq(taskInvitations.taskId, taskId), eq(taskInvitations.providerProfileId, prov.id)));
    await tx
      .update(taskInvitations)
      .set({ status: "expired" })
      .where(and(eq(taskInvitations.taskId, taskId), ne(taskInvitations.providerProfileId, prov.id), inArray(taskInvitations.status, ["invited", "viewed", "interested", "quoted", "negotiating"])));

    await recordActivity(tx, {
      projectId, actorUserId: userId, eventType: "quote.accepted", subjectType: "quote", subjectId: id,
      payload: { version: version.version, currency: version.currency, totalMinor: version.totalMinor, assignmentId: assignment.id },
    });
    await recordActivity(tx, {
      projectId, actorUserId: userId, eventType: "assignment.offered", subjectType: "assignment", subjectId: assignment.id,
      payload: { taskId, providerProfileId: prov.id, quoteId: id },
    });
    await recordActivity(tx, {
      projectId, actorUserId: userId, eventType: "task.transitioned", subjectType: "task", subjectId: taskId,
      payload: { from: "offered", to: "assigned", via: "quote_accepted" },
    });
    await notify(tx, [prov.userId], "quote.accepted", { projectId, taskId, quoteId: id }, userId);
    return { status: 200, body: { quote: accepted, assignment, task: { id: taskId, status: "assigned" } } };
  });
});
