import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  assignments, changeRequestTasks, changeRequests, conversationParticipants, conversationReads, conversations, disputes, languages,
  merchantOrders, merchants, messageConfirmations, messageTranscripts, messages, milestones, projectMembers, providerProfiles, quotes,
  stages, tasks, users,
} from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { isPlatformAdmin } from "../authz/platform-admin.js";
import { getProjectRoles, isProviderOnly, PROJECT_MANAGERS, providerVisibleTaskIds } from "../authz/projects.js";
import { getSpeech, AiUnavailable } from "../ai/providers.js";
import { readerLanguages, storeTranslations, translateExisting, translationsFor } from "../i18n/translate.js";
import { runIdempotent } from "../lib/idempotency.js";
import { flagMessage } from "../lib/moderation.js";
import { managerUserIds, notify } from "../lib/notify.js";
import type { Executor } from "../db/types.js";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http.js";

// PRD §31-35 contextual chat: one conversation per (context type, context id). Access follows project membership,
// the assigned task and explicit parties, never blanket membership (PRD §34). Originals are never overwritten (§28);
// translations are separate rows with provenance (§29); consequential contexts ask for "Confirm understanding" (§30).
// The pre-award private thread in thread-routes.ts is untouched.

const TYPES = ["project", "stage", "task", "quote", "change_request", "milestone", "dispute", "merchant_order"] as const;
type CtxType = (typeof TYPES)[number];
const CONSEQUENTIAL = new Set<CtxType>(["quote", "change_request", "milestone", "dispute"]);
const typeParam = (v: string): CtxType => {
  if (!(TYPES as readonly string[]).includes(v)) throw new ApiError(404, "not_found", "Not found");
  return v as CtxType;
};
const notFound = () => new ApiError(404, "not_found", "Not found");
const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do this");

type Resolved = { projectId: string | null; taskId: string | null; participants: string[]; consequential: boolean };

async function providerUsers(ex: Executor, taskIds: readonly string[]): Promise<string[]> {
  if (taskIds.length === 0) return [];
  const rows = await ex.select({ uid: providerProfiles.userId }).from(assignments)
    .innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId))
    .where(and(inArray(assignments.taskId, [...taskIds]), inArray(assignments.status, ["offered", "accepted", "active", "completed"])));
  return [...new Set(rows.map((r) => r.uid))];
}

async function nonProviderMembers(ex: Executor, projectId: string): Promise<string[]> {
  const rows = await ex.select({ uid: projectMembers.userId }).from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), notInArray(projectMembers.role, ["provider", "provider_team_member"])));
  return [...new Set(rows.map((r) => r.uid))];
}

export async function resolveContext(ex: Executor, userId: string, type: CtxType, id: string): Promise<Resolved> {
  const consequential = CONSEQUENTIAL.has(type);
  const managerOrOwner = (roles: string[]) => roles.some((r) => (PROJECT_MANAGERS as readonly string[]).includes(r));

  if (type === "project" || type === "stage") {
    let projectId = id;
    if (type === "stage") {
      const [s] = await ex.select({ p: stages.projectId }).from(stages).where(eq(stages.id, id)).limit(1);
      if (!s) throw notFound();
      projectId = s.p;
    }
    const roles = await getProjectRoles(ex, projectId, userId);
    if (roles.length === 0) throw notFound();
    if (isProviderOnly(roles)) throw forbidden(); // providers talk in task, quote, milestone and change chats (PRD §34)
    return { projectId, taskId: null, participants: await nonProviderMembers(ex, projectId), consequential };
  }
  if (type === "task") {
    const [t] = await ex.select({ p: tasks.projectId }).from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!t) throw notFound();
    const roles = await getProjectRoles(ex, t.p, userId);
    if (roles.length === 0) throw notFound();
    if (isProviderOnly(roles) && !(await providerVisibleTaskIds(ex, t.p, userId)).includes(id)) throw forbidden();
    return { projectId: t.p, taskId: id, participants: [...(await nonProviderMembers(ex, t.p)), ...(await providerUsers(ex, [id]))], consequential };
  }
  if (type === "quote") {
    const [q] = await ex.select({ p: quotes.projectId, prov: providerProfiles.userId }).from(quotes).innerJoin(providerProfiles, eq(providerProfiles.id, quotes.providerProfileId)).where(eq(quotes.id, id)).limit(1);
    if (!q || !q.p) throw notFound();
    const roles = await getProjectRoles(ex, q.p, userId);
    if (!(q.prov === userId || managerOrOwner(roles))) throw roles.length === 0 && q.prov !== userId ? notFound() : forbidden();
    return { projectId: q.p, taskId: null, participants: [...(await managerUserIds(ex, q.p)), q.prov], consequential };
  }
  if (type === "change_request") {
    const [cr] = await ex.select().from(changeRequests).where(eq(changeRequests.id, id)).limit(1);
    if (!cr) throw notFound();
    const roles = await getProjectRoles(ex, cr.projectId, userId);
    if (roles.length === 0) throw notFound();
    const affected = (await ex.select({ t: changeRequestTasks.taskId }).from(changeRequestTasks).where(eq(changeRequestTasks.changeRequestId, id))).map((r) => r.t);
    if (isProviderOnly(roles)) {
      const visible = await providerVisibleTaskIds(ex, cr.projectId, userId);
      if (!affected.some((t) => visible.includes(t))) throw forbidden();
    }
    return { projectId: cr.projectId, taskId: null, participants: [...(await managerUserIds(ex, cr.projectId)), cr.requestedByUserId, ...(await providerUsers(ex, affected))], consequential };
  }
  if (type === "milestone") {
    const [m] = await ex.select().from(milestones).where(eq(milestones.id, id)).limit(1);
    if (!m) throw notFound();
    const roles = await getProjectRoles(ex, m.projectId, userId);
    if (roles.length === 0) throw notFound();
    let provider: string[] = [];
    if (m.assignmentId) {
      const [a] = await ex.select({ uid: providerProfiles.userId }).from(assignments).innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId)).where(eq(assignments.id, m.assignmentId)).limit(1);
      provider = a ? [a.uid] : [];
    }
    if (isProviderOnly(roles) && !provider.includes(userId)) throw forbidden();
    return { projectId: m.projectId, taskId: null, participants: [...(await managerUserIds(ex, m.projectId)), ...provider], consequential };
  }
  if (type === "dispute") {
    const [d] = await ex.select().from(disputes).where(eq(disputes.id, id)).limit(1);
    if (!d) throw notFound();
    const managers = await managerUserIds(ex, d.projectId);
    const party = [d.openedByUserId, d.againstUserId].filter((x): x is string => !!x);
    if (!(party.includes(userId) || managers.includes(userId) || isPlatformAdmin(userId))) throw notFound();
    return { projectId: d.projectId, taskId: null, participants: [...party, ...managers], consequential };
  }
  // merchant_order
  const [o] = await ex.select({ o: merchantOrders, owner: merchants.ownerUserId }).from(merchantOrders).innerJoin(merchants, eq(merchants.id, merchantOrders.merchantId)).where(eq(merchantOrders.id, id)).limit(1);
  if (!o) throw notFound();
  if (o.o.buyerUserId !== userId && o.owner !== userId) throw notFound();
  return { projectId: o.o.projectId, taskId: o.o.taskId, participants: [o.o.buyerUserId, o.owner], consequential };
}

async function ensureConversation(ex: Executor, type: CtxType, id: string, projectId: string | null): Promise<string> {
  await ex.insert(conversations).values({ projectId, contextType: type, contextId: id }).onConflictDoNothing();
  const [c] = await ex.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.contextType, type), eq(conversations.contextId, id))).limit(1);
  if (!c) throw new ApiError(500, "internal", "Conversation missing");
  return c.id;
}

async function assertLanguage(ex: Executor, code: string) {
  const [l] = await ex.select({ c: languages.code }).from(languages).where(eq(languages.code, code)).limit(1);
  if (!l) throw new ApiError(400, "unknown_language", "That language is not supported");
}

export const conversationRoutes = new Hono<AuthEnv>();
conversationRoutes.use("*", requireAuth);

// On-demand translation (a message sent before translation was on, or when it failed).
const translateBody = z.strictObject({ to: z.string().trim().min(2).max(12).optional() });
conversationRoutes.post("/messages/:mid/translate", async (c) => {
  const userId = c.get("auth").userId;
  const mid = uuidParam(c.req.param("mid"));
  const b = parseOrThrow(translateBody, await readJson(c));
  const [m] = await db.select({ conv: messages.conversationId }).from(messages).where(eq(messages.id, mid)).limit(1);
  if (!m) throw notFound();
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, m.conv)).limit(1);
  if (!conv || conv.contextType === "private") throw notFound();
  await resolveContext(db, userId, conv.contextType as CtxType, conv.contextId);
  const [me] = await db.select({ lang: users.preferredLanguage }).from(users).where(eq(users.id, userId)).limit(1);
  const to = b.to ?? me?.lang ?? "en";
  await assertLanguage(db, to);
  const t = await translateExisting(db, mid, to, userId);
  if (!t) return c.json({ translation: null, available: false, note: "Translation is not available right now. The original message is unchanged." });
  return c.json({ translation: t, available: true });
});

conversationRoutes.post("/messages/:mid/confirm", async (c) => {
  const userId = c.get("auth").userId;
  const mid = uuidParam(c.req.param("mid"));
  return runIdempotent(c, { scope: "messages.confirm", userId, body: { mid } }, async (tx) => {
    const [m] = await tx.select({ conv: messages.conversationId, sender: messages.senderUserId }).from(messages).where(eq(messages.id, mid)).limit(1);
    if (!m) throw notFound();
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, m.conv)).limit(1);
    if (!conv || conv.contextType === "private") throw notFound();
    await resolveContext(tx, userId, conv.contextType as CtxType, conv.contextId);
    if (m.sender === userId) throw new ApiError(409, "own_message", "You cannot confirm your own message");
    await tx.insert(messageConfirmations).values({ messageId: mid, userId }).onConflictDoNothing();
    return { status: 200, body: { confirmed: true } };
  });
});

conversationRoutes.get("/:type/:id/messages", async (c) => {
  const userId = c.get("auth").userId;
  const type = typeParam(c.req.param("type"));
  const id = uuidParam(c.req.param("id"));
  const ctx = await resolveContext(db, userId, type, id);
  const [conv] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.contextType, type), eq(conversations.contextId, id))).limit(1);
  if (!conv) return c.json({ messages: [], consequential: ctx.consequential });
  const [me] = await db.select({ lang: users.preferredLanguage, auto: users.autoTranslate, showOrig: users.showOriginalByDefault }).from(users).where(eq(users.id, userId)).limit(1);
  const rows = await db
    .select({ m: messages, name: users.displayName })
    .from(messages).innerJoin(users, eq(users.id, messages.senderUserId))
    .where(eq(messages.conversationId, conv.id)).orderBy(desc(messages.createdAt)).limit(200);
  rows.reverse();
  const ids = rows.map((r) => r.m.id);
  const tr = me?.auto ? await translationsFor(db, ids, me?.lang ?? "en") : new Map();
  const confirmed = new Set(ids.length === 0 ? [] : (await db.select({ m: messageConfirmations.messageId }).from(messageConfirmations).where(and(inArray(messageConfirmations.messageId, ids), eq(messageConfirmations.userId, userId)))).map((r) => r.m));
  const confirmedByOthers = new Set(ids.length === 0 ? [] : (await db.select({ m: messageConfirmations.messageId }).from(messageConfirmations).where(and(inArray(messageConfirmations.messageId, ids), sql`${messageConfirmations.userId} <> ${userId}`))).map((r) => r.m));
  const transcripts = new Map<string, string>();
  if (ids.length > 0) for (const t of await db.select().from(messageTranscripts).where(inArray(messageTranscripts.messageId, ids))) transcripts.set(t.messageId, t.text);

  return c.json({
    consequential: ctx.consequential,
    viewer: { language: me?.lang ?? "en", autoTranslate: me?.auto ?? true, showOriginalByDefault: me?.showOrig ?? false },
    messages: rows.map(({ m, name }) => {
      const mine = m.senderUserId === userId;
      const t = mine ? undefined : tr.get(m.id);
      return {
        id: m.id, mine, senderName: name, createdAt: m.createdAt, attachments: m.attachments, transcript: transcripts.get(m.id) ?? null,
        original: { text: m.originalText, language: m.originalLanguage },
        display: t ? { text: t.text, language: t.language, translated: true, provenance: { provider: t.provider, model: t.model, confidence: t.confidence, translatedAt: t.translatedAt } } : { text: m.originalText, language: m.originalLanguage, translated: false },
        needsConfirmation: ctx.consequential && !mine && !!t && !confirmed.has(m.id),
        confirmed: mine ? confirmedByOthers.has(m.id) : confirmed.has(m.id),
        canTranslate: !mine && !t && m.originalLanguage !== (me?.lang ?? "en"),
      };
    }),
  });
});

const sendBody = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  language: z.string().trim().min(2).max(12).optional(),
  clientMessageId: z.string().trim().min(1).max(100).optional(),
});

async function postMessage(ex: Executor, o: { userId: string; type: CtxType; id: string; text: string; language?: string; clientMessageId?: string; attachments?: unknown[]; transcript?: { text: string; language: string | null; provider: string; model: string | null; confidence: number | null } }) {
  const ctx = await resolveContext(ex, o.userId, o.type, o.id);
  const [me] = await ex.select({ lang: users.preferredLanguage }).from(users).where(eq(users.id, o.userId)).limit(1);
  if (!me) throw new ApiError(401, "unauthorized", "Missing or invalid credentials");
  const language = o.language ?? me.lang;
  await assertLanguage(ex, language);
  const convId = await ensureConversation(ex, o.type, o.id, ctx.projectId);
  await ex.insert(conversationParticipants).values({ conversationId: convId, userId: o.userId }).onConflictDoNothing();
  const [row] = await ex.insert(messages).values({
    conversationId: convId, projectId: ctx.projectId, taskId: ctx.taskId, senderUserId: o.userId, originalText: o.text, originalLanguage: language,
    clientMessageId: o.clientMessageId ?? null, attachments: o.attachments ?? [],
  }).returning({ id: messages.id, createdAt: messages.createdAt });
  if (o.transcript) {
    await ex.insert(messageTranscripts).values({
      messageId: row.id, language: o.transcript.language, text: o.transcript.text, provider: o.transcript.provider, model: o.transcript.model,
      confidence: o.transcript.confidence === null ? null : o.transcript.confidence.toFixed(3),
    }).onConflictDoNothing();
  }
  const others = [...new Set(ctx.participants)].filter((u) => u !== o.userId);
  const translated = await storeTranslations(ex, row.id, o.userId, o.text, language, await readerLanguages(ex, others));
  const flags = await flagMessage(ex, row.id, o.text);
  await notify(ex, others, "message.received", { contextType: o.type, contextId: o.id, projectId: ctx.projectId }, o.userId);
  return { id: row.id, createdAt: row.createdAt, translations: translated, flagged: flags.length > 0 };
}

conversationRoutes.post("/:type/:id/messages", async (c) => {
  const userId = c.get("auth").userId;
  const type = typeParam(c.req.param("type"));
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(sendBody, raw);
  return runIdempotent(c, { scope: "conversations.send", userId, body: { type, id, raw } }, async (tx) => {
    const m = await postMessage(tx, { userId, type, id, text: b.text, language: b.language, clientMessageId: b.clientMessageId });
    return { status: 201, body: { message: m } };
  });
});

// PRD §35: a voice note keeps the recording (uploaded like evidence) and gets a transcript with provenance.
const voiceBody = z.strictObject({
  storagePath: z.string().trim().min(3).max(500),
  mimeType: z.string().trim().min(3).max(100),
  durationSec: z.int().min(1).max(600).optional(),
  language: z.string().trim().min(2).max(12).optional(),
  transcript: z.string().trim().min(1).max(4000).optional(),
});
conversationRoutes.post("/:type/:id/voice", async (c) => {
  const userId = c.get("auth").userId;
  const type = typeParam(c.req.param("type"));
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(voiceBody, raw);
  return runIdempotent(c, { scope: "conversations.voice", userId, body: { type, id, raw } }, async (tx) => {
    let transcript: { text: string; language: string | null; provider: string; model: string | null; confidence: number | null } | undefined;
    if (b.transcript) transcript = { text: b.transcript, language: b.language ?? null, provider: "device", model: null, confidence: null };
    else {
      const sp = getSpeech();
      if (sp.available()) {
        try { transcript = await sp.transcribe({ storagePath: b.storagePath, mimeType: b.mimeType, languageHint: b.language ?? null }); } catch (e) { if (!(e instanceof AiUnavailable)) throw e; }
      }
    }
    const m = await postMessage(tx, {
      userId, type, id, text: transcript?.text ?? "(voice message)", language: b.language,
      attachments: [{ kind: "voice", storagePath: b.storagePath, mimeType: b.mimeType, durationSec: b.durationSec ?? null }], transcript,
    });
    return { status: 201, body: { message: m, transcribed: !!transcript } };
  });
});

conversationRoutes.post("/:type/:id/read", async (c) => {
  const userId = c.get("auth").userId;
  const type = typeParam(c.req.param("type"));
  const id = uuidParam(c.req.param("id"));
  await resolveContext(db, userId, type, id);
  const [conv] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.contextType, type), eq(conversations.contextId, id))).limit(1);
  if (conv) {
    await db.insert(conversationReads).values({ conversationId: conv.id, userId, lastReadAt: new Date() })
      .onConflictDoUpdate({ target: [conversationReads.conversationId, conversationReads.userId], set: { lastReadAt: new Date() } });
  }
  return c.json({ ok: true });
});

// Unread counts across the caller's conversations (a project member sees only contexts they may open).
conversationRoutes.get("/unread", async (c) => {
  const userId = c.get("auth").userId;
  const mine = await db.select({ cid: conversationParticipants.conversationId }).from(conversationParticipants).where(eq(conversationParticipants.userId, userId));
  if (mine.length === 0) return c.json({ conversations: [] });
  const ids = mine.map((m) => m.cid);
  const convs = await db.select().from(conversations).where(inArray(conversations.id, ids));
  const reads = await db.select().from(conversationReads).where(and(eq(conversationReads.userId, userId), inArray(conversationReads.conversationId, ids)));
  const out: { contextType: string; contextId: string; projectId: string | null; unread: number }[] = [];
  for (const cv of convs) {
    if (cv.contextType === "private") continue;
    const since = reads.find((r) => r.conversationId === cv.id)?.lastReadAt;
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(messages)
      .where(and(eq(messages.conversationId, cv.id), sql`${messages.senderUserId} <> ${userId}`, since ? sql`${messages.createdAt} > ${since}` : sql`true`));
    if ((n?.n ?? 0) > 0) out.push({ contextType: cv.contextType, contextId: cv.contextId, projectId: cv.projectId, unread: n.n });
  }
  return c.json({ conversations: out });
});

