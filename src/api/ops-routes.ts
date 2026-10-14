import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import {
  assets, assignments, disputes, evidence, issues, milestones, projectDocuments, projectUpdates, projects, safetyIncidents, tasks,
  warranties,
} from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { requirePlatformAdmin } from "../authz/platform-admin";
import { isProviderOnly, PROJECT_MANAGERS, providerVisibleTaskIds, requireProjectRole } from "../authz/projects";
import { recordActivity } from "../lib/activity";
import { runIdempotent } from "../lib/idempotency";
import { getStorage } from "../lib/storage";
import { managerUserIds, notify } from "../lib/notify";
import { EMERGENCY_NOTE } from "../ai/rules";
import type { Executor } from "../db/types";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http";

// PRD §65 (updates, blockers, material requests), §78 (issues), §79 (safety incidents), §138 (documents),
// §139-140 (handover and closure). Providers only touch tasks they are assigned to (PRD §34).

const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do this");
const isMgr = (roles: readonly string[]) => roles.some((r) => (PROJECT_MANAGERS as readonly string[]).includes(r));

/** A provider-only member may only attach things to tasks they can see. Managers may attach to any task of the project. */
async function assertTaskInProject(ex: Executor, projectId: string, taskId: string | undefined, userId: string, roles: readonly string[]) {
  if (!taskId) {
    if (isProviderOnly(roles as never)) throw forbidden();
    return;
  }
  const [t] = await ex.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId))).limit(1);
  if (!t) throw new ApiError(404, "not_found", "Not found");
  if (isProviderOnly(roles as never) && !(await providerVisibleTaskIds(ex, projectId, userId)).includes(taskId)) throw forbidden();
}

export const opsRoutes = new Hono<AuthEnv>();
opsRoutes.use("*", requireAuth);

// ── updates ──────────────────────────────────────────────────────────────────
const updateBody = z.strictObject({
  kind: z.enum(["progress", "blocker", "material_request", "note"]).default("progress"),
  body: z.string().trim().min(1).max(4000),
  taskId: z.uuid().optional(),
});
opsRoutes.post("/:id/updates", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(updateBody, raw);
  return runIdempotent(c, { scope: "projects.update", userId, body: { projectId, raw } }, async (tx) => {
    const roles = await requireProjectRole(tx, projectId, userId);
    await assertTaskInProject(tx, projectId, b.taskId, userId, roles);
    const [row] = await tx.insert(projectUpdates).values({ projectId, taskId: b.taskId ?? null, authorUserId: userId, kind: b.kind, body: b.body }).returning({ id: projectUpdates.id, createdAt: projectUpdates.createdAt });
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: `update.${b.kind}`, subjectType: "project_update", subjectId: row.id, payload: { taskId: b.taskId ?? null } });
    if (b.kind === "blocker" || b.kind === "material_request") await notify(tx, await managerUserIds(tx, projectId), `update.${b.kind}`, { projectId, taskId: b.taskId ?? null, updateId: row.id }, userId);
    return { status: 201, body: { update: { id: row.id, createdAt: row.createdAt } } };
  });
});
opsRoutes.get("/:id/updates", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const roles = await requireProjectRole(db, projectId, userId);
  const visible = isProviderOnly(roles) ? await providerVisibleTaskIds(db, projectId, userId) : null;
  const rows = await db.select().from(projectUpdates).where(eq(projectUpdates.projectId, projectId)).orderBy(desc(projectUpdates.createdAt)).limit(200);
  return c.json({ updates: rows.filter((r) => !visible || (r.taskId !== null && visible.includes(r.taskId))) });
});

// ── issues ───────────────────────────────────────────────────────────────────
const issueBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  category: z.enum(["material_unavailable", "site_inaccessible", "safety_risk", "defective_equipment", "provider_delay", "dependency_blocked", "other"]).default("other"),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  affectedTaskIds: z.array(z.uuid()).max(30).default([]),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  ownerUserId: z.uuid().optional(),
});
opsRoutes.post("/:id/issues", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(issueBody, raw);
  return runIdempotent(c, { scope: "projects.issue", userId, body: { projectId, raw } }, async (tx) => {
    const roles = await requireProjectRole(tx, projectId, userId);
    if (b.affectedTaskIds.length > 0) {
      const ok = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, projectId), inArray(tasks.id, b.affectedTaskIds)));
      if (ok.length !== new Set(b.affectedTaskIds).size) throw new ApiError(400, "unknown_task", "Some affected tasks are not in this project");
      for (const t of b.affectedTaskIds) await assertTaskInProject(tx, projectId, t, userId, roles);
    } else if (isProviderOnly(roles)) throw forbidden();
    const [row] = await tx.insert(issues).values({
      projectId, title: b.title, description: b.description ?? null, category: b.category, severity: b.severity, affectedTaskIds: b.affectedTaskIds,
      dueAt: b.dueAt ? new Date(b.dueAt) : null, ownerUserId: b.ownerUserId ?? null, raisedByUserId: userId,
    }).returning({ id: issues.id });
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: "issue.opened", subjectType: "issue", subjectId: row.id, payload: { severity: b.severity, category: b.category } });
    await notify(tx, await managerUserIds(tx, projectId), "issue.opened", { projectId, issueId: row.id, severity: b.severity }, userId);
    return { status: 201, body: { issue: { id: row.id, status: "open" } } };
  });
});
opsRoutes.get("/:id/issues", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const roles = await requireProjectRole(db, projectId, userId);
  const visible = isProviderOnly(roles) ? await providerVisibleTaskIds(db, projectId, userId) : null;
  const rows = await db.select().from(issues).where(eq(issues.projectId, projectId)).orderBy(desc(issues.createdAt)).limit(200);
  return c.json({ issues: rows.filter((r) => !visible || r.affectedTaskIds.some((t) => visible.includes(t)) || r.raisedByUserId === userId) });
});

export const issueRoutes = new Hono<AuthEnv>();
issueRoutes.use("*", requireAuth);
const issueUpdateBody = z.strictObject({ status: z.enum(["acknowledged", "resolved", "closed"]), resolution: z.string().trim().max(2000).optional() });
const ISSUE_NEXT: Record<string, string[]> = { open: ["acknowledged", "resolved", "closed"], acknowledged: ["resolved", "closed"], resolved: ["closed", "open"], closed: [] };
issueRoutes.post("/:id/status", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(issueUpdateBody, raw);
  return runIdempotent(c, { scope: "issues.status", userId, body: { id, raw } }, async (tx) => {
    const [i] = await tx.select().from(issues).where(eq(issues.id, id)).limit(1).for("update");
    if (!i) throw new ApiError(404, "not_found", "Not found");
    await requireProjectRole(tx, i.projectId, userId, PROJECT_MANAGERS);
    if (!ISSUE_NEXT[i.status]?.includes(b.status)) throw new ApiError(409, "invalid_transition", `An issue that is ${i.status} cannot become ${b.status}`);
    if (b.status === "resolved" && !b.resolution) throw new ApiError(400, "resolution_required", "Say how the issue was resolved");
    await tx.update(issues).set({ status: b.status, resolution: b.resolution ?? i.resolution, resolvedAt: b.status === "resolved" ? new Date() : i.resolvedAt }).where(eq(issues.id, id));
    await recordActivity(tx, { projectId: i.projectId, actorUserId: userId, eventType: `issue.${b.status}`, subjectType: "issue", subjectId: id, payload: {} });
    await notify(tx, [i.raisedByUserId], `issue.${b.status}`, { projectId: i.projectId, issueId: id }, userId);
    return { status: 200, body: { issue: { id, status: b.status } } };
  });
});

// ── safety incidents (PRD §79-80): dedicated, not buried in chat ─────────────
export const safetyRoutes = new Hono<AuthEnv>();
safetyRoutes.use("*", requireAuth);
const incidentBody = z.strictObject({
  projectId: z.uuid().optional(),
  taskId: z.uuid().optional(),
  category: z.enum(["personal_injury", "property_damage", "electrical_hazard", "fire", "equipment_damage", "security_concern", "unsafe_site"]),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  description: z.string().trim().min(5).max(4000),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  emergencyServicesContacted: z.boolean().default(false),
});
safetyRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(incidentBody, raw);
  return runIdempotent(c, { scope: "safety.report", userId, body: raw }, async (tx) => {
    if (b.projectId) {
      const roles = await requireProjectRole(tx, b.projectId, userId);
      if (b.taskId) await assertTaskInProject(tx, b.projectId, b.taskId, userId, roles);
    } else if (b.taskId) throw new ApiError(400, "project_required", "Give the project when you give a task");
    const [row] = await tx.insert(safetyIncidents).values({
      projectId: b.projectId ?? null, taskId: b.taskId ?? null, reporterUserId: userId, category: b.category, severity: b.severity, description: b.description,
      occurredAt: b.occurredAt ? new Date(b.occurredAt) : new Date(), emergencyServicesContacted: b.emergencyServicesContacted,
    }).returning({ id: safetyIncidents.id });
    if (b.projectId) {
      await recordActivity(tx, { projectId: b.projectId, actorUserId: userId, eventType: "safety.incident_reported", subjectType: "safety_incident", subjectId: row.id, payload: { category: b.category, severity: b.severity } });
      await notify(tx, await managerUserIds(tx, b.projectId), "safety.incident_reported", { projectId: b.projectId, incidentId: row.id, severity: b.severity }, userId);
    }
    const urgent = b.severity === "critical" || b.severity === "high" || b.category === "fire" || b.category === "personal_injury";
    return { status: 201, body: { incident: { id: row.id, status: "reported" }, ...(urgent && !b.emergencyServicesContacted ? { emergencyNote: EMERGENCY_NOTE } : {}) } };
  });
});
safetyRoutes.get("/mine", async (c) => {
  const userId = c.get("auth").userId;
  const rows = await db.select().from(safetyIncidents).where(eq(safetyIncidents.reporterUserId, userId)).orderBy(desc(safetyIncidents.createdAt)).limit(100);
  return c.json({ incidents: rows });
});
safetyRoutes.get("/", async (c) => {
  requirePlatformAdmin(c.get("auth").userId);
  const status = c.req.query("status");
  const rows = await db.select().from(safetyIncidents).where(status ? eq(safetyIncidents.status, status) : sql`true`).orderBy(desc(safetyIncidents.createdAt)).limit(200);
  return c.json({ incidents: rows });
});
const incidentStatusBody = z.strictObject({ status: z.enum(["under_review", "closed"]) });
safetyRoutes.post("/:id/status", async (c) => {
  const userId = c.get("auth").userId;
  requirePlatformAdmin(userId);
  const id = uuidParam(c.req.param("id"));
  const b = parseOrThrow(incidentStatusBody, await readJson(c));
  return runIdempotent(c, { scope: "safety.status", userId, body: { id, b } }, async (tx) => {
    const r = await tx.update(safetyIncidents).set({ status: b.status }).where(eq(safetyIncidents.id, id)).returning({ id: safetyIncidents.id });
    if (r.length === 0) throw new ApiError(404, "not_found", "Not found");
    return { status: 200, body: { incident: { id, status: b.status } } };
  });
});

// ── documents (PRD §138): access-controlled, versioned ───────────────────────
const DOC_RULES: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const docKinds = ["specification", "drawing", "invoice", "receipt", "contract", "certificate", "inspection_report", "warranty", "manual", "other"] as const;
const docUploadBody = z.strictObject({ mimeType: z.string().trim().min(3).max(100), sizeBytes: z.int().min(1).max(25 * 1024 * 1024) });
opsRoutes.post("/:id/documents/upload-url", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(docUploadBody, raw);
  const ext = DOC_RULES[b.mimeType];
  if (!ext) throw new ApiError(400, "unsupported_media_type", `A document must be one of: ${Object.keys(DOC_RULES).join(", ")}`);
  return runIdempotent(c, { scope: "documents.upload_url", userId, body: { projectId, raw } }, async (tx) => {
    await requireProjectRole(tx, projectId, userId);
    const storagePath = `projects/${projectId}/documents/${randomUUID()}.${ext}`;
    return { status: 201, body: { storagePath, upload: await getStorage().createUpload(storagePath, b.mimeType) } };
  });
});

const docBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(docKinds).default("other"),
  storagePath: z.string().trim().min(3).max(500),
  mimeType: z.string().trim().min(3).max(100),
  taskId: z.uuid().optional(),
  managersOnly: z.boolean().default(false),
  supersedesDocumentId: z.uuid().optional(),
});
opsRoutes.post("/:id/documents", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(docBody, raw);
  if (!b.storagePath.startsWith(`projects/${projectId}/documents/`)) throw new ApiError(400, "invalid_storage_path", "That file was not uploaded for this project");
  return runIdempotent(c, { scope: "documents.add", userId, body: { projectId, raw } }, async (tx) => {
    const roles = await requireProjectRole(tx, projectId, userId);
    await assertTaskInProject(tx, projectId, b.taskId, userId, roles);
    const head = await getStorage().head(b.storagePath);
    if (!head) throw new ApiError(409, "file_not_uploaded", "The file has not been uploaded yet");
    let version = 1;
    if (b.supersedesDocumentId) {
      const [old] = await tx.select().from(projectDocuments).where(and(eq(projectDocuments.id, b.supersedesDocumentId), eq(projectDocuments.projectId, projectId))).limit(1);
      if (!old) throw new ApiError(404, "not_found", "Not found");
      version = old.version + 1;
    }
    const [row] = await tx.insert(projectDocuments).values({
      projectId, taskId: b.taskId ?? null, uploaderUserId: userId, name: b.name, kind: b.kind, storagePath: b.storagePath, mimeType: b.mimeType, sizeBytes: head.sizeBytes,
      version, supersedesDocumentId: b.supersedesDocumentId ?? null, managersOnly: b.managersOnly && isMgr(roles),
    }).returning({ id: projectDocuments.id });
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: "document.added", subjectType: "document", subjectId: row.id, payload: { kind: b.kind, version } });
    return { status: 201, body: { document: { id: row.id, version } } };
  });
});
opsRoutes.get("/:id/documents", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const roles = await requireProjectRole(db, projectId, userId);
  const visible = isProviderOnly(roles) ? await providerVisibleTaskIds(db, projectId, userId) : null;
  const rows = await db.select().from(projectDocuments).where(eq(projectDocuments.projectId, projectId)).orderBy(desc(projectDocuments.createdAt));
  const superseded = new Set(rows.map((r) => r.supersedesDocumentId).filter((x): x is string => !!x));
  const out = [];
  for (const r of rows) {
    if (r.managersOnly && !isMgr(roles)) continue;
    if (visible && !(r.taskId !== null && visible.includes(r.taskId))) continue;
    out.push({ id: r.id, name: r.name, kind: r.kind, version: r.version, mimeType: r.mimeType, sizeBytes: r.sizeBytes, taskId: r.taskId, current: !superseded.has(r.id), createdAt: r.createdAt, url: r.storagePath ? await getStorage().createDownloadUrl(r.storagePath, 300) : null });
  }
  return c.json({ documents: out });
});

// ── handover and closure (PRD §139-140) ──────────────────────────────────────
async function handoverChecklist(ex: Executor, projectId: string) {
  const ts = await ex.select({ id: tasks.id, status: tasks.status }).from(tasks).where(eq(tasks.projectId, projectId));
  const open = ts.filter((t) => !["approved", "completed", "cancelled"].includes(t.status));
  const ms = await ex.select({ id: milestones.id, status: milestones.status }).from(milestones).where(eq(milestones.projectId, projectId));
  const unpaid = ms.filter((m) => !["released", "cancelled"].includes(m.status));
  const [ev] = await ex.select({ n: sql<number>`count(*)::int` }).from(evidence).where(eq(evidence.projectId, projectId));
  const [docs] = await ex.select({ n: sql<number>`count(*)::int` }).from(projectDocuments).where(eq(projectDocuments.projectId, projectId));
  const [w] = await ex.select({ n: sql<number>`count(*)::int` }).from(warranties).where(eq(warranties.projectId, projectId));
  const [a] = await ex.select({ n: sql<number>`count(*)::int` }).from(assets).where(eq(assets.projectId, projectId));
  const [oi] = await ex.select({ n: sql<number>`count(*)::int` }).from(issues).where(and(eq(issues.projectId, projectId), inArray(issues.status, ["open", "acknowledged"])));
  const [od] = await ex.select({ n: sql<number>`count(*)::int` }).from(disputes).where(and(eq(disputes.projectId, projectId), inArray(disputes.status, ["open", "awaiting_response", "in_review"])));
  const items = [
    { key: "tasks_done", label: "Every task is approved, completed or cancelled", ok: open.length === 0, blocking: true, detail: open.length > 0 ? `${open.length} still open` : null },
    { key: "final_payment", label: "Every milestone is released or cancelled", ok: unpaid.length === 0, blocking: true, detail: unpaid.length > 0 ? `${unpaid.length} not released` : null },
    { key: "no_open_disputes", label: "No open disputes", ok: (od?.n ?? 0) === 0, blocking: true, detail: null },
    { key: "no_open_issues", label: "No open issues, or they are declared", ok: (oi?.n ?? 0) === 0, blocking: false, detail: (oi?.n ?? 0) > 0 ? `${oi.n} open` : null },
    { key: "final_evidence", label: "Final evidence is on file", ok: (ev?.n ?? 0) > 0, blocking: false, detail: null },
    { key: "documents", label: "Documents such as warranties and manuals are stored", ok: (docs?.n ?? 0) > 0, blocking: false, detail: null },
    { key: "warranty", label: "A warranty is recorded", ok: (w?.n ?? 0) > 0, blocking: false, detail: null },
    { key: "asset", label: "Installed items are registered as assets", ok: (a?.n ?? 0) > 0, blocking: false, detail: null },
  ];
  return { items, canClose: items.filter((i) => i.blocking).every((i) => i.ok) };
}

opsRoutes.get("/:id/handover", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  await requireProjectRole(db, projectId, userId, PROJECT_MANAGERS);
  return c.json(await handoverChecklist(db, projectId));
});

const handoverBody = z.strictObject({
  outcome: z.enum(["completed", "aftercare"]),
  unresolvedIssueDeclaration: z.string().trim().max(2000).optional(),
});
opsRoutes.post("/:id/handover", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(handoverBody, raw);
  return runIdempotent(c, { scope: "projects.handover", userId, body: { projectId, raw } }, async (tx) => {
    await requireProjectRole(tx, projectId, userId, PROJECT_MANAGERS);
    const [p] = await tx.select({ status: projects.status }).from(projects).where(eq(projects.id, projectId)).limit(1).for("update");
    if (!p) throw new ApiError(404, "not_found", "Not found");
    if (p.status !== "active" && p.status !== "draft" && !(p.status === "aftercare" && b.outcome === "completed")) throw new ApiError(409, "project_not_open", `A ${p.status} project cannot be handed over`);
    const list = await handoverChecklist(tx, projectId);
    if (!list.canClose) throw new ApiError(409, "handover_blocked", "Blocking items remain", list.items.filter((i) => i.blocking && !i.ok));
    const openIssues = list.items.find((i) => i.key === "no_open_issues");
    if (openIssues && !openIssues.ok && !b.unresolvedIssueDeclaration) throw new ApiError(400, "declaration_required", "Declare the unresolved issues before closing");
    await tx.update(projects).set({ status: b.outcome, completedAt: new Date() }).where(eq(projects.id, projectId));
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: `project.${b.outcome}`, subjectType: "project", subjectId: projectId, payload: { declaration: b.unresolvedIssueDeclaration ?? null } });
    return { status: 200, body: { project: { id: projectId, status: b.outcome } } };
  });
});

// Closure keeps everything: this read-only record is what stays after the project ends (PRD §140).
opsRoutes.get("/:id/closure-record", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const roles = await requireProjectRole(db, projectId, userId, PROJECT_MANAGERS);
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) throw new ApiError(404, "not_found", "Not found");
  const ms = await db.select({ title: milestones.title, amountMinor: milestones.amountMinor, currency: milestones.currency, status: milestones.status }).from(milestones).where(eq(milestones.projectId, projectId)).orderBy(asc(milestones.position));
  const asg = await db.select({ taskId: assignments.taskId, providerProfileId: assignments.providerProfileId, status: assignments.status }).from(assignments).innerJoin(tasks, eq(tasks.id, assignments.taskId)).where(eq(tasks.projectId, projectId));
  const [ev] = await db.select({ n: sql<number>`count(*)::int` }).from(evidence).where(eq(evidence.projectId, projectId));
  return c.json({ record: { project: { id: p.id, title: p.title, status: p.status, currency: p.currency, createdAt: p.createdAt, completedAt: p.completedAt }, baselineVersion: p.currentBaselineVersion, milestones: ms, providers: asg, evidenceCount: ev?.n ?? 0, roles } });
});

