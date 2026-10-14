import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  assignments, availabilityExceptions, bookings, cancellationPolicies, checkIns, marketHolidays, markets, projectBudgets, projectMembers,
  projects, providerAvailability, providerProfiles, recurringOccurrences, recurringServices, stages, taskInvitations, tasks, users,
} from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { isPlatformAdmin, requirePlatformAdmin } from "../authz/platform-admin.js";
import { getProjectRoles, PROJECT_MANAGERS } from "../authz/projects.js";
import { recordActivity } from "../lib/activity.js";
import { runIdempotent } from "../lib/idempotency.js";
import { managerUserIds, notify } from "../lib/notify.js";
import type { Executor } from "../db/types.js";
import { ApiError, isIanaTimezone, parseOrThrow, readJson, uuidParam } from "./http.js";

// PRD §41-43 (time zones, calendars, travel), §71-75 (scheduling, check-in, cancellation, no-show), §118 (recurring).
// Every timestamp is stored as an instant (timestamptz) and shown in the viewer's zone; rules read the PROJECT's zone.

const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do this");
const notFound = () => new ApiError(404, "not_found", "Not found");

/** Weekday (0=Sun) and minutes-since-midnight of an instant in an IANA zone. */
export function localParts(d: Date, tz: string): { weekday: number; minutes: number; ymd: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday));
  return { weekday: wd, minutes: Number(p.hour) * 60 + Number(p.minute), ymd: `${p.year}-${p.month}-${p.day}` };
}

async function taskAccess(ex: Executor, taskId: string, userId: string) {
  const [t] = await ex.select({ id: tasks.id, projectId: tasks.projectId, title: tasks.title }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) throw notFound();
  const roles = await getProjectRoles(ex, t.projectId, userId);
  if (roles.length === 0) throw notFound();
  const [prof] = await ex.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
  const [asg] = await ex.select({ id: assignments.id, providerProfileId: assignments.providerProfileId, status: assignments.status }).from(assignments)
    .where(and(eq(assignments.taskId, taskId), inArray(assignments.status, ["offered", "accepted", "active"]))).limit(1);
  return {
    task: t, roles, isManager: roles.some((r) => (PROJECT_MANAGERS as readonly string[]).includes(r)),
    profileId: prof?.id ?? null, assignment: asg ?? null, isAssignedProvider: !!(prof && asg && asg.providerProfileId === prof.id),
  };
}

// ── availability (PRD §71-72): only what is needed, never calendar contents ──
export const availabilityRoutes = new Hono<AuthEnv>();
availabilityRoutes.use("*", requireAuth);

async function myProfile(ex: Executor, userId: string) {
  const [p] = await ex.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
  if (!p) throw notFound();
  return p.id;
}

availabilityRoutes.get("/me/availability", async (c) => {
  const pid = await myProfile(db, c.get("auth").userId);
  const windows = await db.select().from(providerAvailability).where(eq(providerAvailability.providerProfileId, pid)).orderBy(asc(providerAvailability.weekday), asc(providerAvailability.startMinute));
  const exceptions = await db.select().from(availabilityExceptions).where(and(eq(availabilityExceptions.providerProfileId, pid), gt(availabilityExceptions.endsAt, new Date()))).orderBy(asc(availabilityExceptions.startsAt));
  return c.json({ windows, exceptions });
});

const windowsBody = z.strictObject({
  timezone: z.string().trim().min(1).max(64).optional(),
  windows: z.array(z.strictObject({ weekday: z.int().min(0).max(6), startMinute: z.int().min(0).max(1439), endMinute: z.int().min(1).max(1440) })
    .refine((w) => w.endMinute > w.startMinute, { message: "endMinute must be after startMinute" })).max(70),
});
availabilityRoutes.put("/me/availability", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(windowsBody, raw);
  return runIdempotent(c, { scope: "availability.set", userId, body: raw }, async (tx) => {
    const pid = await myProfile(tx, userId);
    const [me] = await tx.select({ tz: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
    const tz = b.timezone ?? me?.tz ?? "UTC";
    if (!isIanaTimezone(tz)) throw new ApiError(400, "invalid_timezone", "timezone must be an IANA name such as Africa/Lagos");
    await tx.delete(providerAvailability).where(eq(providerAvailability.providerProfileId, pid));
    if (b.windows.length > 0) await tx.insert(providerAvailability).values(b.windows.map((w) => ({ providerProfileId: pid, weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute, timezone: tz })));
    return { status: 200, body: { windows: b.windows.length, timezone: tz } };
  });
});

const exceptionBody = z.strictObject({ startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }), reason: z.string().trim().max(200).optional() });
availabilityRoutes.post("/me/availability/exceptions", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(exceptionBody, raw);
  if (new Date(b.endsAt) <= new Date(b.startsAt)) throw new ApiError(400, "invalid_range", "endsAt must be after startsAt");
  return runIdempotent(c, { scope: "availability.exception", userId, body: raw }, async (tx) => {
    const pid = await myProfile(tx, userId);
    const [row] = await tx.insert(availabilityExceptions).values({ providerProfileId: pid, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt), reason: b.reason ?? null }).returning({ id: availabilityExceptions.id });
    return { status: 201, body: { exception: { id: row.id } } };
  });
});
availabilityRoutes.delete("/me/availability/exceptions/:id", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  return runIdempotent(c, { scope: "availability.exception_delete", userId, body: { id } }, async (tx) => {
    const pid = await myProfile(tx, userId);
    await tx.delete(availabilityExceptions).where(and(eq(availabilityExceptions.id, id), eq(availabilityExceptions.providerProfileId, pid)));
    return { status: 200, body: { deleted: true } };
  });
});

// Coarse location + radius used by ranking (PRD §39-41). Only approximate values are ever stored (PRD §40).
const locationBody = z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), serviceRadiusKm: z.int().min(1).max(2000).optional() });
availabilityRoutes.put("/me/location", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(locationBody, raw);
  return runIdempotent(c, { scope: "providers.location", userId, body: raw }, async (tx) => {
    const pid = await myProfile(tx, userId);
    await tx.update(providerProfiles).set({ approxLat: b.lat.toFixed(2), approxLng: b.lng.toFixed(2), serviceRadiusKm: b.serviceRadiusKm ?? null }).where(eq(providerProfiles.id, pid));
    return { status: 200, body: { approxLat: Number(b.lat.toFixed(2)), approxLng: Number(b.lng.toFixed(2)), serviceRadiusKm: b.serviceRadiusKm ?? null } };
  });
});

// What a customer may see of a provider's time: windows plus anonymous busy blocks, nothing else.
availabilityRoutes.get("/:id/availability", async (c) => {
  const pid = uuidParam(c.req.param("id"));
  const windows = await db.select({ weekday: providerAvailability.weekday, startMinute: providerAvailability.startMinute, endMinute: providerAvailability.endMinute, timezone: providerAvailability.timezone })
    .from(providerAvailability).where(eq(providerAvailability.providerProfileId, pid));
  const horizon = new Date(Date.now() + 14 * 86400_000);
  const busy = await db.select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt }).from(bookings)
    .where(and(eq(bookings.providerProfileId, pid), inArray(bookings.status, ["proposed", "confirmed"]), gt(bookings.endsAt, new Date()), lt(bookings.startsAt, horizon)));
  const off = await db.select({ startsAt: availabilityExceptions.startsAt, endsAt: availabilityExceptions.endsAt }).from(availabilityExceptions)
    .where(and(eq(availabilityExceptions.providerProfileId, pid), gt(availabilityExceptions.endsAt, new Date()), lt(availabilityExceptions.startsAt, horizon)));
  return c.json({ windows, busy: [...busy, ...off] });
});

// ── bookings (PRD §71, §74-75) ───────────────────────────────────────────────
export const bookingTaskRoutes = new Hono<AuthEnv>();
bookingTaskRoutes.use("*", requireAuth);
export const bookingRoutes = new Hono<AuthEnv>();
bookingRoutes.use("*", requireAuth);

const DEFAULT_RULES = [{ hoursBefore: 24, feePercent: 0 }, { hoursBefore: 2, feePercent: 25 }, { hoursBefore: 0, feePercent: 50 }];

async function policyFor(ex: Executor, key: string | null) {
  if (!key) return { key: null as string | null, rules: DEFAULT_RULES };
  const [p] = await ex.select().from(cancellationPolicies).where(eq(cancellationPolicies.key, key)).limit(1);
  return { key: p?.key ?? null, rules: p && p.rules.length > 0 ? p.rules : DEFAULT_RULES };
}
export function cancellationFee(rules: { hoursBefore: number; feePercent: number }[], startsAt: Date, now = new Date()) {
  const hoursLeft = (startsAt.getTime() - now.getTime()) / 3600_000;
  const sorted = [...rules].sort((a, b) => b.hoursBefore - a.hoursBefore);
  const rule = sorted.find((r) => hoursLeft >= r.hoursBefore) ?? sorted[sorted.length - 1];
  return { feePercent: rule?.feePercent ?? 0, hoursLeft: Math.round(hoursLeft * 10) / 10 };
}

async function scheduleWarnings(ex: Executor, o: { projectId: string; providerProfileId: string; startsAt: Date; endsAt: Date; travelBufferMin: number; excludeId?: string }) {
  const warnings: string[] = [];
  const [p] = await ex.select({ tz: projects.timezone, marketId: projects.marketId }).from(projects).where(eq(projects.id, o.projectId)).limit(1);
  if (!p) return { warnings, conflict: false };
  const lp = localParts(o.startsAt, p.tz);
  const [m] = await ex.select({ workingDays: markets.workingDays }).from(markets).where(eq(markets.id, p.marketId)).limit(1);
  if (m && Array.isArray(m.workingDays) && !m.workingDays.includes(lp.weekday)) warnings.push("non_working_day");
  const [h] = await ex.select({ n: marketHolidays.name }).from(marketHolidays).where(and(eq(marketHolidays.marketId, p.marketId), eq(marketHolidays.holidayDate, lp.ymd))).limit(1);
  if (h) warnings.push("public_holiday");

  const wins = await ex.select().from(providerAvailability).where(eq(providerAvailability.providerProfileId, o.providerProfileId));
  if (wins.length > 0) {
    const ok = wins.some((w) => {
      const s = localParts(o.startsAt, w.timezone);
      const e = localParts(o.endsAt, w.timezone);
      return s.weekday === w.weekday && s.ymd === e.ymd && s.minutes >= w.startMinute && e.minutes <= w.endMinute;
    });
    if (!ok) warnings.push("outside_availability");
  }
  const [off] = await ex.select({ id: availabilityExceptions.id }).from(availabilityExceptions)
    .where(and(eq(availabilityExceptions.providerProfileId, o.providerProfileId), lt(availabilityExceptions.startsAt, o.endsAt), gt(availabilityExceptions.endsAt, o.startsAt))).limit(1);
  if (off) warnings.push("provider_marked_unavailable");

  const bufMs = o.travelBufferMin * 60_000;
  const overlapping = await ex.select({ id: bookings.id, status: bookings.status, buf: bookings.travelBufferMin, s: bookings.startsAt, e: bookings.endsAt }).from(bookings)
    .where(and(eq(bookings.providerProfileId, o.providerProfileId), inArray(bookings.status, ["proposed", "confirmed"]), lt(bookings.startsAt, new Date(o.endsAt.getTime() + bufMs)), gt(bookings.endsAt, new Date(o.startsAt.getTime() - bufMs))));
  const others = overlapping.filter((x) => x.id !== o.excludeId);
  const conflict = others.some((x) => x.status === "confirmed");
  if (others.some((x) => x.status === "proposed")) warnings.push("overlaps_proposed_booking");
  return { warnings, conflict };
}

const bookBody = z.strictObject({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  travelBufferMin: z.int().min(0).max(600).default(0),
  policyKey: z.string().trim().max(80).optional(),
  note: z.string().trim().max(1000).optional(),
});

bookingTaskRoutes.post("/:id/bookings", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(bookBody, raw);
  const startsAt = new Date(b.startsAt);
  const endsAt = new Date(b.endsAt);
  if (endsAt <= startsAt) throw new ApiError(400, "invalid_range", "endsAt must be after startsAt");
  if (startsAt.getTime() < Date.now() - 60_000) throw new ApiError(400, "in_the_past", "A booking must start in the future");
  return runIdempotent(c, { scope: "bookings.create", userId, body: { taskId, raw } }, async (tx) => {
    const a = await taskAccess(tx, taskId, userId);
    if (!a.assignment) throw new ApiError(409, "no_assignment", "Book a time after a provider has been chosen for this task");
    if (!a.isManager && !a.isAssignedProvider) throw forbidden();
    const { warnings, conflict } = await scheduleWarnings(tx, { projectId: a.task.projectId, providerProfileId: a.assignment.providerProfileId, startsAt, endsAt, travelBufferMin: b.travelBufferMin });
    if (conflict) throw new ApiError(409, "booking_conflict", "That time clashes with a confirmed booking for this provider", { warnings });
    const pol = await policyFor(tx, b.policyKey ?? "standard");
    const [row] = await tx.insert(bookings).values({
      projectId: a.task.projectId, taskId, assignmentId: a.assignment.id, providerProfileId: a.assignment.providerProfileId, startsAt, endsAt,
      travelBufferMin: b.travelBufferMin, cancellationPolicyKey: pol.key, proposedByUserId: userId, note: b.note ?? null,
    }).returning({ id: bookings.id, status: bookings.status });
    await recordActivity(tx, { projectId: a.task.projectId, actorUserId: userId, eventType: "booking.proposed", subjectType: "booking", subjectId: row.id, payload: { taskId, startsAt: b.startsAt, endsAt: b.endsAt, warnings } });
    const [prov] = await tx.select({ uid: providerProfiles.userId }).from(providerProfiles).where(eq(providerProfiles.id, a.assignment.providerProfileId)).limit(1);
    await notify(tx, a.isManager ? [prov?.uid ?? ""].filter(Boolean) : await managerUserIds(tx, a.task.projectId), "booking.proposed", { projectId: a.task.projectId, taskId, bookingId: row.id }, userId);
    return { status: 201, body: { booking: { id: row.id, status: row.status, cancellationPolicyKey: pol.key }, warnings } };
  });
});

bookingTaskRoutes.get("/:id/bookings", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const a = await taskAccess(db, taskId, userId);
  if (!a.isManager && !a.isAssignedProvider) throw forbidden();
  const rows = await db.select().from(bookings).where(eq(bookings.taskId, taskId)).orderBy(asc(bookings.startsAt));
  return c.json({ bookings: rows });
});

async function loadBooking(ex: Executor, id: string, userId: string) {
  const [b] = await ex.select().from(bookings).where(eq(bookings.id, id)).limit(1).for("update");
  if (!b) throw notFound();
  const roles = await getProjectRoles(ex, b.projectId, userId);
  const isManager = roles.some((r) => (PROJECT_MANAGERS as readonly string[]).includes(r));
  const [prof] = await ex.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
  const isProvider = !!prof && prof.id === b.providerProfileId;
  if (!isManager && !isProvider) throw roles.length === 0 ? notFound() : forbidden();
  return { b, isManager, isProvider };
}

bookingRoutes.post("/:id/confirm", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  return runIdempotent(c, { scope: "bookings.confirm", userId, body: { id } }, async (tx) => {
    const { b } = await loadBooking(tx, id, userId);
    if (b.proposedByUserId === userId) throw new ApiError(409, "own_proposal", "The other party confirms a proposed time");
    if (b.status !== "proposed") throw new ApiError(409, "not_proposed", `A ${b.status} booking cannot be confirmed`);
    const { conflict } = await scheduleWarnings(tx, { projectId: b.projectId, providerProfileId: b.providerProfileId, startsAt: b.startsAt, endsAt: b.endsAt, travelBufferMin: b.travelBufferMin, excludeId: b.id });
    if (conflict) throw new ApiError(409, "booking_conflict", "That time now clashes with a confirmed booking");
    await tx.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, id));
    await recordActivity(tx, { projectId: b.projectId, actorUserId: userId, eventType: "booking.confirmed", subjectType: "booking", subjectId: id, payload: { taskId: b.taskId } });
    await notify(tx, [b.proposedByUserId], "booking.confirmed", { projectId: b.projectId, taskId: b.taskId, bookingId: id }, userId);
    return { status: 200, body: { booking: { id, status: "confirmed" } } };
  });
});

const cancelBody = z.strictObject({ reason: z.string().trim().max(500).optional() });
bookingRoutes.post("/:id/cancel", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(cancelBody, raw);
  return runIdempotent(c, { scope: "bookings.cancel", userId, body: { id, raw } }, async (tx) => {
    const { b: bk } = await loadBooking(tx, id, userId);
    if (!["proposed", "confirmed"].includes(bk.status)) throw new ApiError(409, "not_cancellable", `A ${bk.status} booking cannot be cancelled`);
    const pol = await policyFor(tx, bk.cancellationPolicyKey);
    const fee = bk.status === "confirmed" ? cancellationFee(pol.rules, bk.startsAt) : { feePercent: 0, hoursLeft: 0 };
    await tx.update(bookings).set({ status: "cancelled", cancelledReason: b.reason ?? null }).where(eq(bookings.id, id));
    await recordActivity(tx, { projectId: bk.projectId, actorUserId: userId, eventType: "booking.cancelled", subjectType: "booking", subjectId: id, payload: { feePercent: fee.feePercent, hoursLeft: fee.hoursLeft } });
    return { status: 200, body: { booking: { id, status: "cancelled" }, policy: { key: pol.key, ...fee, note: "The policy was set before booking. A fee is a record here; collecting it is a payment step." } } };
  });
});

const rescheduleBody = z.strictObject({ startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }), note: z.string().trim().max(1000).optional() });
bookingRoutes.post("/:id/reschedule", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(rescheduleBody, raw);
  const startsAt = new Date(b.startsAt);
  const endsAt = new Date(b.endsAt);
  if (endsAt <= startsAt) throw new ApiError(400, "invalid_range", "endsAt must be after startsAt");
  return runIdempotent(c, { scope: "bookings.reschedule", userId, body: { id, raw } }, async (tx) => {
    const { b: old } = await loadBooking(tx, id, userId);
    if (!["proposed", "confirmed"].includes(old.status)) throw new ApiError(409, "not_reschedulable", `A ${old.status} booking cannot be moved`);
    const { warnings, conflict } = await scheduleWarnings(tx, { projectId: old.projectId, providerProfileId: old.providerProfileId, startsAt, endsAt, travelBufferMin: old.travelBufferMin, excludeId: old.id });
    if (conflict) throw new ApiError(409, "booking_conflict", "That time clashes with a confirmed booking", { warnings });
    await tx.update(bookings).set({ status: "rescheduled" }).where(eq(bookings.id, id));
    const [row] = await tx.insert(bookings).values({
      projectId: old.projectId, taskId: old.taskId, assignmentId: old.assignmentId, providerProfileId: old.providerProfileId, startsAt, endsAt,
      travelBufferMin: old.travelBufferMin, cancellationPolicyKey: old.cancellationPolicyKey, proposedByUserId: userId, note: b.note ?? old.note,
    }).returning({ id: bookings.id });
    await recordActivity(tx, { projectId: old.projectId, actorUserId: userId, eventType: "booking.rescheduled", subjectType: "booking", subjectId: row.id, payload: { from: id, startsAt: b.startsAt } });
    return { status: 201, body: { booking: { id: row.id, status: "proposed", replaces: id }, warnings } };
  });
});

const noShowBody = z.strictObject({ party: z.enum(["provider", "customer"]) });
bookingRoutes.post("/:id/no-show", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(noShowBody, raw);
  return runIdempotent(c, { scope: "bookings.no_show", userId, body: { id, raw } }, async (tx) => {
    const { b: bk, isManager, isProvider } = await loadBooking(tx, id, userId);
    // The affected party reports: the customer side reports a provider no-show and the provider reports a customer no-show.
    if (b.party === "provider" ? !isManager : !isProvider) throw forbidden();
    if (bk.status !== "confirmed") throw new ApiError(409, "not_confirmed", "Only a confirmed booking can be marked as a no-show");
    if (bk.startsAt.getTime() > Date.now()) throw new ApiError(409, "not_started", "The booking has not started yet");
    const status = b.party === "provider" ? "no_show_provider" : "no_show_customer";
    await tx.update(bookings).set({ status }).where(eq(bookings.id, id));
    await recordActivity(tx, { projectId: bk.projectId, actorUserId: userId, eventType: `booking.${status}`, subjectType: "booking", subjectId: id, payload: { taskId: bk.taskId } });
    const next = b.party === "provider" ? ["rematch another provider", "ask for a refund of any funded amount", "the miss is recorded against the provider's reliability"] : ["reschedule", "a waiting or travel fee may apply under the policy set before booking"];
    return { status: 200, body: { booking: { id, status }, options: next } };
  });
});

bookingRoutes.get("/mine", async (c) => {
  const userId = c.get("auth").userId;
  const from = c.req.query("from") ? new Date(String(c.req.query("from"))) : new Date(Date.now() - 86400_000);
  const to = c.req.query("to") ? new Date(String(c.req.query("to"))) : new Date(Date.now() + 30 * 86400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new ApiError(400, "invalid_range", "from and to must be dates");
  const [prof] = await db.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
  const mineProjects = db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, userId));
  const rows = await db
    .select({ b: bookings, task: tasks.title, project: projects.title, tz: projects.timezone })
    .from(bookings).innerJoin(tasks, eq(tasks.id, bookings.taskId)).innerJoin(projects, eq(projects.id, bookings.projectId))
    .where(and(gt(bookings.endsAt, from), lt(bookings.startsAt, to), inArray(bookings.status, ["proposed", "confirmed", "completed"]),
      prof ? sql`(${bookings.providerProfileId} = ${prof.id} or ${bookings.projectId} in (${mineProjects}))` : sql`${bookings.projectId} in (${mineProjects})`))
    .orderBy(asc(bookings.startsAt)).limit(200);
  return c.json({ bookings: rows.map((r) => ({ ...r.b, taskTitle: r.task, projectTitle: r.project, projectTimezone: r.tz })) });
});

// ── check-in (PRD §73): optional, coarse, never continuous tracking ──────────
export const checkInRoutes = new Hono<AuthEnv>();
checkInRoutes.use("*", requireAuth);
const checkInBody = z.strictObject({
  kind: z.enum(["en_route", "arrived", "started", "left"]),
  etaMinutes: z.int().min(0).max(1440).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
checkInRoutes.post("/:id/check-in", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(checkInBody, raw);
  return runIdempotent(c, { scope: "tasks.check_in", userId, body: { taskId, raw } }, async (tx) => {
    const a = await taskAccess(tx, taskId, userId);
    if (!a.isAssignedProvider || !a.assignment || !["accepted", "active"].includes(a.assignment.status)) throw forbidden();
    const [row] = await tx.insert(checkIns).values({
      projectId: a.task.projectId, taskId, providerProfileId: a.assignment.providerProfileId, kind: b.kind, etaMinutes: b.etaMinutes ?? null,
      approxLat: b.lat === undefined ? null : b.lat.toFixed(3), approxLng: b.lng === undefined ? null : b.lng.toFixed(3),
    }).returning({ id: checkIns.id, createdAt: checkIns.createdAt });
    await recordActivity(tx, { projectId: a.task.projectId, actorUserId: userId, eventType: `task.${b.kind}`, subjectType: "task", subjectId: taskId, payload: { etaMinutes: b.etaMinutes ?? null } });
    if (b.kind === "en_route" || b.kind === "arrived") await notify(tx, await managerUserIds(tx, a.task.projectId), `task.${b.kind}`, { projectId: a.task.projectId, taskId, etaMinutes: b.etaMinutes ?? null }, userId);
    return { status: 201, body: { checkIn: { id: row.id, kind: b.kind, createdAt: row.createdAt } } };
  });
});
checkInRoutes.get("/:id/check-ins", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const a = await taskAccess(db, taskId, userId);
  if (!a.isManager && !a.isAssignedProvider) throw forbidden();
  const rows = await db.select().from(checkIns).where(eq(checkIns.taskId, taskId)).orderBy(asc(checkIns.createdAt)).limit(100);
  return c.json({ checkIns: rows });
});

// ── cancellation policies (PRD §74): defined before booking ──────────────────
export const policyRoutes = new Hono<AuthEnv>();
policyRoutes.use("*", requireAuth);
policyRoutes.get("/", async (c) => {
  const rows = await db.select().from(cancellationPolicies).orderBy(asc(cancellationPolicies.key));
  return c.json({ policies: rows });
});
const policyBody = z.strictObject({
  key: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
  marketCode: z.string().trim().max(10).optional(),
  categoryKey: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
  rules: z.array(z.strictObject({ hoursBefore: z.number().min(0).max(8760), feePercent: z.number().min(0).max(100) })).min(1).max(10),
});
policyRoutes.put("/", async (c) => {
  const userId = c.get("auth").userId;
  requirePlatformAdmin(userId);
  const raw = await readJson(c);
  const b = parseOrThrow(policyBody, raw);
  return runIdempotent(c, { scope: "policies.put", userId, body: raw }, async (tx) => {
    const [m] = b.marketCode ? await tx.select({ id: markets.id }).from(markets).where(eq(markets.code, b.marketCode)).limit(1) : [];
    if (b.marketCode && !m) throw new ApiError(400, "unknown_market", "Unknown market code");
    await tx.insert(cancellationPolicies).values({ key: b.key, marketId: m?.id ?? null, categoryKey: b.categoryKey ?? null, rules: b.rules, description: b.description ?? null })
      .onConflictDoUpdate({ target: cancellationPolicies.key, set: { marketId: m?.id ?? null, categoryKey: b.categoryKey ?? null, rules: b.rules, description: b.description ?? null } });
    return { status: 200, body: { policy: { key: b.key } } };
  });
});

// ── recurring services (PRD §117-118) ────────────────────────────────────────
export function addInterval(ymd: string, frequency: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (frequency === "daily" || frequency === "custom") d.setUTCDate(d.getUTCDate() + n);
  else if (frequency === "weekly") d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (frequency === "monthly") d.setUTCMonth(d.getUTCMonth() + n);
  else if (frequency === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3 * n);
  else if (frequency === "annual") d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}

export async function generateOccurrence(ex: Executor, svcId: string): Promise<{ projectId: string | null; dueOn: string } | null> {
  const [svc] = await ex.select().from(recurringServices).where(eq(recurringServices.id, svcId)).limit(1).for("update");
  if (!svc || !svc.isActive) return null;
  const dueOn = svc.nextDueOn;
  const claimed = await ex.insert(recurringOccurrences).values({ recurringServiceId: svc.id, dueOn, status: "generated" }).onConflictDoNothing().returning({ id: recurringOccurrences.id });
  const next = addInterval(dueOn, svc.frequency, svc.intervalCount);
  const finished = svc.endsOn !== null && next > svc.endsOn;
  if (claimed.length === 0) {
    await ex.update(recurringServices).set({ nextDueOn: next, isActive: !finished }).where(eq(recurringServices.id, svc.id));
    return null;
  }
  const [p] = await ex.insert(projects).values({
    ownerUserId: svc.ownerUserId, organisationId: svc.organisationId, marketId: svc.marketId, title: `${svc.title} (${dueOn})`, currency: svc.currency, timezone: svc.timezone,
  }).returning({ id: projects.id });
  await ex.insert(projectMembers).values({ projectId: p.id, userId: svc.ownerUserId, role: "project_owner" });
  await ex.insert(projectBudgets).values({ projectId: p.id, currency: svc.currency });
  const [st] = await ex.insert(stages).values({ projectId: p.id, name: "Scheduled service", position: 0 }).returning({ id: stages.id });
  const template = svc.taskTemplate.length > 0 ? svc.taskTemplate : [{ title: svc.title }];
  let first: string | null = null;
  for (const [i, t] of template.entries()) {
    const [row] = await ex.insert(tasks).values({ projectId: p.id, stageId: st.id, title: t.title, description: t.description ?? null, position: i, status: svc.preferredProviderProfileId ? "ready" : "draft" }).returning({ id: tasks.id });
    first ??= row.id;
    if (svc.preferredProviderProfileId) await ex.insert(taskInvitations).values({ taskId: row.id, providerProfileId: svc.preferredProviderProfileId, invitedByUserId: svc.ownerUserId }).onConflictDoNothing();
  }
  await ex.update(recurringOccurrences).set({ projectId: p.id }).where(and(eq(recurringOccurrences.recurringServiceId, svc.id), eq(recurringOccurrences.dueOn, dueOn)));
  await ex.update(recurringServices).set({ nextDueOn: next, isActive: !finished }).where(eq(recurringServices.id, svc.id));
  await recordActivity(ex, { projectId: p.id, actorType: "system", eventType: "recurring.generated", subjectType: "recurring_service", subjectId: svc.id, payload: { dueOn, firstTaskId: first } });
  await notify(ex, [svc.ownerUserId], "recurring.generated", { projectId: p.id, recurringServiceId: svc.id, dueOn });
  return { projectId: p.id, dueOn };
}

export const recurringRoutes = new Hono<AuthEnv>();
recurringRoutes.use("*", requireAuth);
const recurringBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  categoryKey: z.string().trim().max(120).optional(),
  frequency: z.enum(["daily", "weekly", "monthly", "quarterly", "annual", "custom"]),
  intervalCount: z.int().min(1).max(365).default(1),
  startsOn: z.iso.date(),
  endsOn: z.iso.date().optional(),
  currency: z.string().trim().length(3),
  timezone: z.string().trim().max(64).optional(),
  organisationId: z.uuid().optional(),
  siteId: z.uuid().optional(),
  preferredProviderProfileId: z.uuid().optional(),
  taskTemplate: z.array(z.strictObject({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(2000).optional() })).max(30).default([]),
});
recurringRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(recurringBody, raw);
  return runIdempotent(c, { scope: "recurring.create", userId, body: raw }, async (tx) => {
    const [me] = await tx.select({ tz: users.timezone, marketId: users.marketId }).from(users).where(eq(users.id, userId)).limit(1);
    if (!me?.marketId) throw new ApiError(400, "no_market", "Your account has no market set");
    const tz = b.timezone ?? me.tz;
    if (!isIanaTimezone(tz)) throw new ApiError(400, "invalid_timezone", "timezone must be an IANA name");
    const [row] = await tx.insert(recurringServices).values({
      ownerUserId: userId, organisationId: b.organisationId ?? null, siteId: b.siteId ?? null, title: b.title, categoryKey: b.categoryKey ?? null,
      frequency: b.frequency, intervalCount: b.intervalCount, startsOn: b.startsOn, endsOn: b.endsOn ?? null, nextDueOn: b.startsOn, timezone: tz,
      currency: b.currency, marketId: me.marketId, taskTemplate: b.taskTemplate, preferredProviderProfileId: b.preferredProviderProfileId ?? null,
    }).returning({ id: recurringServices.id, nextDueOn: recurringServices.nextDueOn });
    return { status: 201, body: { recurring: { id: row.id, nextDueOn: row.nextDueOn } } };
  });
});
recurringRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const rows = await db.select().from(recurringServices).where(eq(recurringServices.ownerUserId, userId)).orderBy(asc(recurringServices.nextDueOn));
  return c.json({ recurring: rows });
});
for (const action of ["pause", "resume"] as const) {
  recurringRoutes.post(`/:id/${action}`, async (c) => {
    const userId = c.get("auth").userId;
    const id = uuidParam(c.req.param("id"));
    return runIdempotent(c, { scope: `recurring.${action}`, userId, body: { id } }, async (tx) => {
      const r = await tx.update(recurringServices).set({ isActive: action === "resume" }).where(and(eq(recurringServices.id, id), eq(recurringServices.ownerUserId, userId))).returning({ id: recurringServices.id });
      if (r.length === 0) throw notFound();
      return { status: 200, body: { recurring: { id, isActive: action === "resume" } } };
    });
  });
}
recurringRoutes.post("/:id/run-now", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  return runIdempotent(c, { scope: "recurring.run_now", userId, body: { id } }, async (tx) => {
    const [svc] = await tx.select({ owner: recurringServices.ownerUserId }).from(recurringServices).where(eq(recurringServices.id, id)).limit(1);
    if (!svc || (svc.owner !== userId && !isPlatformAdmin(userId))) throw notFound();
    const out = await generateOccurrence(tx, id);
    return { status: 200, body: { generated: out } };
  });
});
