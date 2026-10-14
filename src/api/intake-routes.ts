import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { requestAnswers, requestAttachments, requests, serviceCategories } from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import type { Executor } from "../db/types";
import {
  EMERGENCY_MESSAGE, MEDIA_RULES, missingRequired, questionsFor, safetyFlags, validateAnswers,
  type AnswerValue, type MediaKind,
} from "../engine/intake-questions";
import { recordActivity } from "../lib/activity";
import { runIdempotent } from "../lib/idempotency";
import { getStorage } from "../lib/storage";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http";

// Request intake: guided questions + photo/video evidence of the problem (PRD §17, §37, §141; DECISIONS D38-D40).
// Owner-only for now: providers see a request's media only after they are invited (matching step, not built yet; PRD §40).

const WRITABLE = ["draft", "open", "matched"];
const DOWNLOAD_TTL_SECONDS = 600;
const PENDING_GRACE_MS = 30 * 60 * 1000; // an abandoned upload stops counting against the limit after 30 minutes
const maxAttachments = () => Number(process.env.INTAKE_MAX_ATTACHMENTS ?? 12);

async function loadOwnRequest(ex: Executor, id: string, userId: string, lock = false) {
  const base = ex
    .select({ id: requests.id, requesterUserId: requests.requesterUserId, status: requests.status, categoryKey: serviceCategories.canonicalKey })
    .from(requests)
    .leftJoin(serviceCategories, eq(serviceCategories.id, requests.categoryId))
    .where(eq(requests.id, id))
    .limit(1);
  // FOR UPDATE ... OF requests: do not lock the shared taxonomy row.
  const rows = lock ? await base.for("update", { of: requests }) : await base;
  const r = rows[0];
  if (!r || r.requesterUserId !== userId) throw new ApiError(404, "not_found", "Not found"); // not yours = does not exist (D21)
  return r;
}
function mustBeWritable(status: string) {
  if (!WRITABLE.includes(status)) throw new ApiError(409, "request_closed", `A ${status} request can no longer be changed`);
}

async function answersOf(ex: Executor, requestId: string): Promise<Record<string, AnswerValue>> {
  const rows = await ex.select({ k: requestAnswers.questionKey, v: requestAnswers.value }).from(requestAnswers).where(eq(requestAnswers.requestId, requestId));
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

function emergencyOf(qs: ReturnType<typeof questionsFor>, answers: Record<string, AnswerValue>) {
  const keys = safetyFlags(qs, answers);
  return keys.length ? { triggered: true, keys, message: EMERGENCY_MESSAGE } : { triggered: false, keys: [] as string[] };
}

const attCols = {
  id: requestAttachments.id,
  kind: requestAttachments.kind,
  status: requestAttachments.status,
  mimeType: requestAttachments.mimeType,
  sizeBytes: requestAttachments.sizeBytes,
  originalFilename: requestAttachments.originalFilename,
  sha256: requestAttachments.sha256,
  createdAt: requestAttachments.createdAt,
  confirmedAt: requestAttachments.confirmedAt,
};

const answersBody = z.strictObject({ answers: z.record(z.string(), z.unknown()).refine((o) => Object.keys(o).length > 0 && Object.keys(o).length <= 30, "Send 1-30 answers") });
const uploadBody = z.strictObject({
  kind: z.enum(["photo", "video", "document"]),
  mimeType: z.string().trim().toLowerCase().min(3).max(100),
  sizeBytes: z.int().min(1),
  filename: z.string().trim().min(1).max(200).optional(),
});
const confirmBody = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters").optional() });
const emptyBody = z.strictObject({});

export const intakeRoutes = new Hono<AuthEnv>();
intakeRoutes.use("*", requireAuth);

// ---- questions + answers ------------------------------------------------------------------------------------

intakeRoutes.get("/:id/questions", async (c) => {
  const userId = c.get("auth").userId;
  const r = await loadOwnRequest(db, uuidParam(c.req.param("id")), userId);
  const qs = questionsFor(r.categoryKey);
  const answers = await answersOf(db, r.id);
  return c.json({
    category: r.categoryKey,
    questions: qs.map((q) => ({ ...q, answered: answers[q.key] !== undefined, value: answers[q.key] ?? null })),
    missingRequired: missingRequired(qs, answers),
    emergency: emergencyOf(qs, answers),
  });
});

// Partial updates are fine: send only the answers just given. Each answer replaces the previous one for that question.
intakeRoutes.put("/:id/answers", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(answersBody, raw);

  return runIdempotent(c, { scope: "requests.save_answers", userId, body: raw }, async (tx) => {
    const r = await loadOwnRequest(tx, id, userId, true);
    mustBeWritable(r.status);
    const qs = questionsFor(r.categoryKey);
    const v = validateAnswers(qs, b.answers);
    if (!v.ok) throw new ApiError(400, "invalid_answers", "Some answers are not valid for this request", v.errors);

    for (const [questionKey, value] of Object.entries(v.clean)) {
      await tx.insert(requestAnswers).values({ requestId: id, questionKey, value }).onConflictDoUpdate({ target: [requestAnswers.requestId, requestAnswers.questionKey], set: { value, updatedAt: new Date() } });
    }
    const all = await answersOf(tx, id);
    const emergency = emergencyOf(qs, all);
    await recordActivity(tx, {
      actorUserId: userId, eventType: "request.answers_saved", subjectType: "request", subjectId: id,
      payload: { keys: Object.keys(v.clean), emergencyTriggered: emergency.triggered },
    });
    return { status: 200, body: { answers: all, missingRequired: missingRequired(qs, all), emergency } };
  });
});

// ---- attachments -------------------------------------------------------------------------------------------------
// 1) POST upload-url -> row `pending` + a signed URL; 2) the device PUTs the file straight to storage (big videos never
// pass through this API); 3) POST confirm -> we look the object up, record its real size, and mark it `ready`.

intakeRoutes.post("/:id/attachments/upload-url", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(uploadBody, raw);
  const rule = MEDIA_RULES[b.kind as MediaKind];
  const ext = rule.mimes[b.mimeType];
  if (!ext) throw new ApiError(400, "unsupported_media_type", `A ${b.kind} must be one of: ${Object.keys(rule.mimes).join(", ")}`);
  if (b.sizeBytes > rule.maxBytes) {
    throw new ApiError(400, "too_large", `A ${b.kind} can be at most ${Math.round(rule.maxBytes / 1048576)} MB; compress it and try again`, { maxBytes: rule.maxBytes });
  }

  return runIdempotent(c, { scope: "requests.attachment_upload_url", userId, body: raw }, async (tx) => {
    const r = await loadOwnRequest(tx, id, userId, true); // the lock serialises concurrent limit checks
    mustBeWritable(r.status);
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(requestAttachments)
      .where(and(eq(requestAttachments.requestId, id), or(eq(requestAttachments.status, "ready"), gt(requestAttachments.createdAt, new Date(Date.now() - PENDING_GRACE_MS)))));
    if (Number(n) >= maxAttachments()) {
      throw new ApiError(409, "attachment_limit", `A request can hold at most ${maxAttachments()} files`, { max: maxAttachments() });
    }

    const storageKey = `requests/${id}/${randomUUID()}.${ext}`;
    const [row] = await tx
      .insert(requestAttachments)
      .values({ requestId: id, uploadedByUserId: userId, kind: b.kind, mimeType: b.mimeType, sizeBytes: b.sizeBytes, originalFilename: b.filename ?? null, storageKey })
      .returning(attCols);
    // If storage refuses, this throws and the whole transaction (row + idempotency key) rolls back.
    const upload = await getStorage().createUpload(storageKey, b.mimeType);
    return { status: 201, body: { attachment: row, upload } };
  });
});

intakeRoutes.post("/:id/attachments/:attId/confirm", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const attId = uuidParam(c.req.param("attId"));
  const raw = await readJson(c);
  const b = parseOrThrow(confirmBody, raw ?? {});

  return runIdempotent(c, { scope: "requests.attachment_confirm", userId, body: raw }, async (tx) => {
    const r = await loadOwnRequest(tx, id, userId);
    mustBeWritable(r.status);
    const [a] = await tx
      .select({ ...attCols, storageKey: requestAttachments.storageKey })
      .from(requestAttachments)
      .where(and(eq(requestAttachments.id, attId), eq(requestAttachments.requestId, id)))
      .limit(1)
      .for("update");
    if (!a) throw new ApiError(404, "not_found", "Not found");
    const { storageKey, ...publicRow } = a;
    if (a.status === "ready") return { status: 200, body: { attachment: publicRow } }; // already confirmed

    const found = await getStorage().head(storageKey);
    if (!found) throw new ApiError(409, "upload_missing", "The file has not reached storage yet; finish the upload and try again");
    const rule = MEDIA_RULES[a.kind as MediaKind];
    if (found.sizeBytes <= 0 || found.sizeBytes > rule.maxBytes) {
      throw new ApiError(409, "upload_too_large", "The uploaded file is empty or over the size limit; delete this attachment and upload a smaller file", { maxBytes: rule.maxBytes });
    }
    const [row] = await tx
      .update(requestAttachments)
      .set({ status: "ready", sizeBytes: found.sizeBytes, confirmedAt: new Date(), ...(b.sha256 ? { sha256: b.sha256 } : {}) })
      .where(eq(requestAttachments.id, attId))
      .returning(attCols);
    await recordActivity(tx, {
      actorUserId: userId, eventType: "request.attachment_added", subjectType: "request", subjectId: id,
      payload: { attachmentId: attId, kind: a.kind, sizeBytes: found.sizeBytes },
    });
    return { status: 200, body: { attachment: row } };
  });
});

intakeRoutes.get("/:id/attachments", async (c) => {
  const userId = c.get("auth").userId;
  const r = await loadOwnRequest(db, uuidParam(c.req.param("id")), userId);
  const rows = await db
    .select({ ...attCols, storageKey: requestAttachments.storageKey })
    .from(requestAttachments)
    .where(eq(requestAttachments.requestId, r.id))
    .orderBy(asc(requestAttachments.createdAt));
  const storage = getStorage();
  const attachments = await Promise.all(
    rows.map(async ({ storageKey, ...a }) => ({
      ...a,
      // Short-lived signed link; only for files that were confirmed.
      downloadUrl: a.status === "ready" ? await storage.createDownloadUrl(storageKey, DOWNLOAD_TTL_SECONDS) : null,
    })),
  );
  return c.json({ attachments });
});

intakeRoutes.delete("/:id/attachments/:attId", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const attId = uuidParam(c.req.param("attId"));
  const raw = await readJson(c);
  parseOrThrow(emptyBody, raw ?? {});

  return runIdempotent(c, { scope: "requests.attachment_delete", userId, body: raw }, async (tx) => {
    const r = await loadOwnRequest(tx, id, userId);
    mustBeWritable(r.status);
    const [a] = await tx
      .delete(requestAttachments)
      .where(and(eq(requestAttachments.id, attId), eq(requestAttachments.requestId, id)))
      .returning({ storageKey: requestAttachments.storageKey, kind: requestAttachments.kind });
    if (!a) throw new ApiError(404, "not_found", "Not found");
    try { await getStorage().remove(a.storageKey); } catch { /* an orphaned object is harmless; a retained row would not be */ }
    await recordActivity(tx, {
      actorUserId: userId, eventType: "request.attachment_removed", subjectType: "request", subjectId: id,
      payload: { attachmentId: attId, kind: a.kind },
    });
    return { status: 200, body: { deleted: true } };
  });
});
