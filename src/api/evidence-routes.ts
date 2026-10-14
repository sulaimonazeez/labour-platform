import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { assignments, evidence, evidenceKind, milestones, projects, providerProfiles, tasks } from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { isProviderOnly, providerVisibleTaskIds, requireProjectRole, type ProjectRole } from "../authz/projects";
import type { Executor } from "../db/types";
import { recordActivity } from "../lib/activity";
import { getStorage } from "../lib/storage";
import { runIdempotent } from "../lib/idempotency";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http";

// Evidence METADATA (PRD §66-67; DECISIONS D37-D39). The file itself is uploaded to private storage by a
// later step; this records what was captured, by whom and when. Rows are append-only (database-enforced).
//   POST /tasks/:id/evidence        GET /tasks/:id/evidence
//   POST /milestones/:id/evidence   GET /milestones/:id/evidence

export const FILE_KINDS: ReadonlySet<string> = new Set([
  "photo_before", "photo_progress", "photo_after", "video", "document", "receipt",
]);
const EVIDENCE_INSPECTORS: readonly ProjectRole[] = ["inspector", "supervisor"];

export const evidenceCols = {
  id: evidence.id,
  projectId: evidence.projectId,
  taskId: evidence.taskId,
  milestoneId: evidence.milestoneId,
  uploaderUserId: evidence.uploaderUserId,
  kind: evidence.kind,
  storagePath: evidence.storagePath,
  mimeType: evidence.mimeType,
  sizeBytes: evidence.sizeBytes,
  fileSha256: evidence.fileSha256,
  capturedAt: evidence.capturedAt,
  captureMeta: evidence.captureMeta,
  createdAt: evidence.createdAt,
};

const evidenceBody = z.strictObject({
  kind: z.enum(evidenceKind.enumValues),
  storagePath: z.string().trim().min(1).max(500).optional(),
  mimeType: z.string().trim().max(100).regex(/^[\w.+-]+\/[\w.+-]+$/, "must look like type/subtype").optional(),
  sizeBytes: z.int().min(0).max(5_000_000_000).optional(),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters").optional(),
  capturedAt: z.iso.datetime().optional(),
  captureMeta: z.record(z.string(), z.unknown()).optional(),
});
export type EvidenceBody = z.output<typeof evidenceBody>;

/** Content rules that do not depend on the database. Throws 400 `evidence_invalid`. */
export function checkEvidenceContent(b: EvidenceBody, projectId: string): void {
  const bad = (message: string) => { throw new ApiError(400, "evidence_invalid", message); };
  const meta = b.captureMeta ?? {};
  if (JSON.stringify(meta).length > 4000) bad("captureMeta is too large (4000 characters max)");
  if (FILE_KINDS.has(b.kind) && !b.storagePath) bad(`${b.kind} evidence needs a storagePath`);
  if (!b.storagePath && Object.keys(meta).length === 0) bad("Provide a storagePath or captureMeta");
  if (b.storagePath) {
    // Object-level safety: a client cannot point evidence at another project's files.
    if (!b.storagePath.startsWith(`projects/${projectId}/`) || b.storagePath.split("/").includes("..")) {
      bad(`storagePath must start with projects/${projectId}/ and contain no ..`);
    }
  }
  if (b.capturedAt && new Date(b.capturedAt).getTime() > Date.now() + 86_400_000) bad("capturedAt cannot be in the future");
}

export async function insertEvidence(
  ex: Executor,
  t: { projectId: string; taskId?: string; milestoneId?: string; userId: string; body: EvidenceBody },
) {
  const b = t.body;
  const [row] = await ex
    .insert(evidence)
    .values({
      projectId: t.projectId,
      taskId: t.taskId ?? null,
      milestoneId: t.milestoneId ?? null,
      uploaderUserId: t.userId,
      kind: b.kind,
      storagePath: b.storagePath ?? null,
      mimeType: b.mimeType ?? null,
      sizeBytes: b.sizeBytes ?? null,
      fileSha256: b.fileSha256 ?? null,
      capturedAt: b.capturedAt ? new Date(b.capturedAt) : null,
      captureMeta: b.captureMeta ?? {},
    })
    .returning(evidenceCols);
  await recordActivity(ex, {
    projectId: t.projectId,
    actorUserId: t.userId,
    eventType: "evidence.added",
    subjectType: "evidence",
    subjectId: row.id,
    payload: { kind: b.kind, ...(t.taskId ? { taskId: t.taskId } : {}), ...(t.milestoneId ? { milestoneId: t.milestoneId } : {}) },
  });
  return row;
}

/** True when the user's provider profile holds this assignment. */
export async function userHoldsAssignment(ex: Executor, assignmentId: string, userId: string, statuses: readonly string[]): Promise<boolean> {
  const rows = await ex
    .select({ id: assignments.id })
    .from(assignments)
    .innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId))
    .where(and(eq(assignments.id, assignmentId), eq(providerProfiles.userId, userId), inArray(assignments.status, [...statuses] as any)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Who may add evidence: the provider holding the live assignment, or an inspector/supervisor.
 * Project owners/managers cannot (the record of work should come from the people doing or checking it).
 * Members without the right: 403; provider-only members who are not on this work: 404 (PRD §34).
 */
export function denyEvidenceWriter(roles: readonly ProjectRole[], holds: boolean): void {
  if (holds || roles.some((r) => EVIDENCE_INSPECTORS.includes(r))) return;
  if (isProviderOnly(roles)) throw new ApiError(404, "not_found", "Not found");
  throw new ApiError(403, "forbidden", "You do not have permission to do this");
}

const TASK_OPEN_FOR_EVIDENCE = ["accepted", "in_progress"];

// Paths issued by POST /tasks/:id/evidence/upload-url look like projects/<id>/evidence/<uuid>.<ext>. For those we check that the
// file really reached storage and record its real size (D75). Metadata-only evidence and older paths are accepted as before.
const ISSUED_PATH = /^projects\/[0-9a-f-]{36}\/evidence\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
async function verifyIssuedUpload(b: EvidenceBody, projectId: string): Promise<EvidenceBody> {
  if (!b.storagePath || !ISSUED_PATH.test(b.storagePath) || !b.storagePath.startsWith(`projects/${projectId}/`)) return b;
  const found = await getStorage().head(b.storagePath);
  if (!found) throw new ApiError(409, "upload_missing", "The file has not reached storage yet; finish the upload and try again");
  if (found.sizeBytes <= 0) throw new ApiError(409, "upload_empty", "The uploaded file is empty");
  return { ...b, sizeBytes: found.sizeBytes };
}

export const taskEvidenceRoutes = new Hono<AuthEnv>();
taskEvidenceRoutes.use("*", requireAuth);

taskEvidenceRoutes.post("/:id/evidence", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(evidenceBody, raw);

  return runIdempotent(c, { scope: "tasks.add_evidence", userId, body: raw }, async (tx) => {
    const [t] = await tx
      .select({ id: tasks.id, projectId: tasks.projectId, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
      .for("share");
    if (!t) throw new ApiError(404, "not_found", "Not found");
    const roles = await requireProjectRole(tx, t.projectId, userId);
    const [asg] = await tx
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.taskId, taskId), inArray(assignments.status, ["accepted", "active"])))
      .limit(1);
    denyEvidenceWriter(roles, asg ? await userHoldsAssignment(tx, asg.id, userId, ["accepted", "active"]) : false);

    const [p] = await tx.select({ status: projects.status }).from(projects).where(eq(projects.id, t.projectId)).limit(1);
    if (!p || (p.status !== "draft" && p.status !== "active")) throw new ApiError(409, "project_not_open", "This project is not open");
    if (!TASK_OPEN_FOR_EVIDENCE.includes(t.status)) {
      throw new ApiError(409, "task_not_open_for_evidence", "Evidence can be added while the task is accepted or in progress", { taskStatus: t.status });
    }
    checkEvidenceContent(b, t.projectId);
    const body = await verifyIssuedUpload(b, t.projectId);
    const row = await insertEvidence(tx, { projectId: t.projectId, taskId, userId, body });
    return { status: 201, body: { evidence: row } };
  });
});

taskEvidenceRoutes.get("/:id/evidence", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const [t] = await db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) throw new ApiError(404, "not_found", "Not found");
  const roles = await requireProjectRole(db, t.projectId, userId);
  if (isProviderOnly(roles) && !(await providerVisibleTaskIds(db, t.projectId, userId)).includes(taskId)) {
    throw new ApiError(404, "not_found", "Not found");
  }
  const rows = await db.select(evidenceCols).from(evidence).where(eq(evidence.taskId, taskId)).orderBy(asc(evidence.createdAt));
  // Private files are shown through short-lived signed links (PRD §132). If storage is unavailable the list still works, without links.
  const withUrls = await Promise.all(rows.map(async (r) => {
    if (!r.storagePath) return { ...r, url: null };
    try { return { ...r, url: await getStorage().createDownloadUrl(r.storagePath, 900) }; } catch { return { ...r, url: null }; }
  }));
  return c.json({ evidence: withUrls });
});

export const milestoneEvidenceRoutes = new Hono<AuthEnv>();
milestoneEvidenceRoutes.use("*", requireAuth);

const MILESTONE_OPEN_FOR_EVIDENCE = ["pending", "funded", "in_progress"];

milestoneEvidenceRoutes.post("/:id/evidence", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(evidenceBody, raw);

  return runIdempotent(c, { scope: "milestones.add_evidence", userId, body: raw }, async (tx) => {
    const [m] = await tx
      .select({ id: milestones.id, projectId: milestones.projectId, assignmentId: milestones.assignmentId, status: milestones.status })
      .from(milestones)
      .where(eq(milestones.id, id))
      .limit(1)
      .for("share");
    if (!m) throw new ApiError(404, "not_found", "Not found");
    const roles = await requireProjectRole(tx, m.projectId, userId);
    const holds = m.assignmentId ? await userHoldsAssignment(tx, m.assignmentId, userId, ["accepted", "active"]) : false;
    denyEvidenceWriter(roles, holds);

    const [p] = await tx.select({ status: projects.status }).from(projects).where(eq(projects.id, m.projectId)).limit(1);
    if (!p || (p.status !== "draft" && p.status !== "active")) throw new ApiError(409, "project_not_open", "This project is not open");
    if (!MILESTONE_OPEN_FOR_EVIDENCE.includes(m.status)) {
      throw new ApiError(409, "milestone_not_open_for_evidence", "Evidence can only be added before the milestone is submitted", { milestoneStatus: m.status });
    }
    checkEvidenceContent(b, m.projectId);
    const row = await insertEvidence(tx, { projectId: m.projectId, milestoneId: id, userId, body: b });
    return { status: 201, body: { evidence: row } };
  });
});

milestoneEvidenceRoutes.get("/:id/evidence", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const [m] = await db.select({ id: milestones.id, projectId: milestones.projectId, assignmentId: milestones.assignmentId }).from(milestones).where(eq(milestones.id, id)).limit(1);
  if (!m) throw new ApiError(404, "not_found", "Not found");
  const roles = await requireProjectRole(db, m.projectId, userId);
  if (isProviderOnly(roles)) {
    const holds = m.assignmentId ? await userHoldsAssignment(db, m.assignmentId, userId, ["offered", "accepted", "active", "completed"]) : false;
    if (!holds) throw new ApiError(404, "not_found", "Not found");
  }
  const rows = await db.select(evidenceCols).from(evidence).where(eq(evidence.milestoneId, id)).orderBy(asc(evidence.createdAt));
  return c.json({ evidence: rows });
});
