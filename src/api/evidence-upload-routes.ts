import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { assignments, projects, tasks } from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { requireProjectRole } from "../authz/projects.js";
import { runIdempotent } from "../lib/idempotency.js";
import { getStorage } from "../lib/storage.js";
import { denyEvidenceWriter, userHoldsAssignment } from "./evidence-routes.js";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http.js";

// Evidence FILES (PRD §66-67, §110, §132). Same three steps as request attachments, so big videos never pass through the API:
//   1) POST /tasks/:id/evidence/upload-url { kind, mimeType, sizeBytes }  -> { storagePath, upload }  (this file)
//   2) the device PUTs the file to `upload.url`
//   3) POST /tasks/:id/evidence { kind, storagePath, ... }  -> verified against storage, real size recorded (evidence-routes.ts)
// Decisions D74-D75 in docs/DECISIONS.md.

const FILE_KINDS = ["photo_before", "photo_progress", "photo_after", "video", "document", "receipt"] as const;
const MB = 1024 * 1024;
const PHOTO = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" } as const;
const RULES: Record<(typeof FILE_KINDS)[number], { mimes: Record<string, string>; maxBytes: number }> = {
  photo_before: { mimes: PHOTO, maxBytes: 15 * MB },
  photo_progress: { mimes: PHOTO, maxBytes: 15 * MB },
  photo_after: { mimes: PHOTO, maxBytes: 15 * MB },
  video: { mimes: { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" }, maxBytes: 100 * MB },
  document: { mimes: { "application/pdf": "pdf" }, maxBytes: 20 * MB },
  receipt: { mimes: { ...PHOTO, "application/pdf": "pdf" }, maxBytes: 20 * MB },
};

const uploadBody = z.strictObject({
  kind: z.enum(FILE_KINDS),
  mimeType: z.string().trim().min(3).max(100),
  sizeBytes: z.int().min(1).max(5_000_000_000),
});

export const taskEvidenceUploadRoutes = new Hono<AuthEnv>();
taskEvidenceUploadRoutes.use("*", requireAuth);

taskEvidenceUploadRoutes.post("/:id/evidence/upload-url", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(uploadBody, raw);
  const rule = RULES[b.kind];
  const ext = rule.mimes[b.mimeType];
  if (!ext) throw new ApiError(400, "unsupported_media_type", `A ${b.kind.replace("_", " ")} must be one of: ${Object.keys(rule.mimes).join(", ")}`);
  if (b.sizeBytes > rule.maxBytes) {
    throw new ApiError(400, "too_large", `This file can be at most ${Math.round(rule.maxBytes / MB)} MB; compress it and try again`, { maxBytes: rule.maxBytes });
  }

  return runIdempotent(c, { scope: "tasks.evidence_upload_url", userId, body: raw }, async (tx) => {
    const [t] = await tx.select({ id: tasks.id, projectId: tasks.projectId, status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1).for("share");
    if (!t) throw new ApiError(404, "not_found", "Not found");
    const roles = await requireProjectRole(tx, t.projectId, userId);
    const [asg] = await tx.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.taskId, taskId), inArray(assignments.status, ["accepted", "active"]))).limit(1);
    denyEvidenceWriter(roles, asg ? await userHoldsAssignment(tx, asg.id, userId, ["accepted", "active"]) : false);
    const [p] = await tx.select({ status: projects.status }).from(projects).where(eq(projects.id, t.projectId)).limit(1);
    if (!p || (p.status !== "draft" && p.status !== "active")) throw new ApiError(409, "project_not_open", "This project is not open");
    if (t.status !== "accepted" && t.status !== "in_progress") {
      throw new ApiError(409, "task_not_open_for_evidence", "Evidence can be added while the task is accepted or in progress", { taskStatus: t.status });
    }
    const storagePath = `projects/${t.projectId}/evidence/${randomUUID()}.${ext}`;
    const upload = await getStorage().createUpload(storagePath, b.mimeType);
    return { status: 201, body: { storagePath, upload } };
  });
});
