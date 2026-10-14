import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { conversationParticipants, conversations, messages, providerProfiles, quotes, taskInvitations, tasks, users } from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { managerUserIds, notify } from "../lib/notify.js";
import { getProjectRoles, PROJECT_MANAGERS } from "../authz/projects.js";
import type { Executor } from "../db/types.js";
import { runIdempotent } from "../lib/idempotency.js";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http.js";

// Pre-award conversation between a project manager and ONE invited provider (PRD §31, §34, §99).
//   GET  /tasks/:id/invitations                         manager: who was invited, and where each one stands
//   GET  /tasks/:id/messages[?provider=<profileId>]     the thread (managers name the provider; a provider gets their own)
//   POST /tasks/:id/messages  { text, provider? }       send a message
// One thread per (task, provider) so invited providers never see each other's conversation. Phone numbers are not
// released here: people talk inside the platform until work is awarded (PRD §99).

export const threadRoutes = new Hono<AuthEnv>();
threadRoutes.use("*", requireAuth);

const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do this");

/** A stable uuid for (task, provider), so the existing conversations table needs no schema change. */
function threadContextId(taskId: string, providerProfileId: string): string {
  const h = createHash("sha1").update(`task-thread:${taskId}:${providerProfileId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function resolveThread(ex: Executor, taskId: string, userId: string, providerParam: string | undefined) {
  const [t] = await ex.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) throw new ApiError(404, "not_found", "Not found");
  const roles = await getProjectRoles(ex, t.projectId, userId);
  const isManager = roles.some((r) => PROJECT_MANAGERS.includes(r));

  let providerProfileId: string;
  if (isManager) {
    if (!providerParam) throw new ApiError(400, "provider_required", "Say which provider this conversation is with");
    providerProfileId = uuidParam(providerParam);
  } else {
    const [prof] = await ex.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
    if (!prof) throw new ApiError(404, "not_found", "Not found");
    providerProfileId = prof.id;
  }
  // Only an invited provider has a thread. Everyone else gets the same answer as "no such task".
  const [inv] = await ex
    .select({ status: taskInvitations.status })
    .from(taskInvitations)
    .where(and(eq(taskInvitations.taskId, taskId), eq(taskInvitations.providerProfileId, providerProfileId)))
    .limit(1);
  if (!inv) {
    if (roles.length > 0 && !isManager) throw forbidden();
    throw new ApiError(404, "not_found", "Not found");
  }
  return { projectId: t.projectId, providerProfileId, contextId: threadContextId(taskId, providerProfileId) };
}

threadRoutes.get("/:id/invitations", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const [t] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) throw new ApiError(404, "not_found", "Not found");
  const roles = await getProjectRoles(db, t.projectId, userId);
  if (roles.length === 0) throw new ApiError(404, "not_found", "Not found");
  if (!roles.some((r) => PROJECT_MANAGERS.includes(r))) throw forbidden();

  const rows = await db
    .select({
      providerProfileId: providerProfiles.id, displayName: providerProfiles.displayName, headline: providerProfiles.headline,
      status: taskInvitations.status, invitedAt: taskInvitations.createdAt,
    })
    .from(taskInvitations)
    .innerJoin(providerProfiles, eq(providerProfiles.id, taskInvitations.providerProfileId))
    .where(eq(taskInvitations.taskId, taskId))
    .orderBy(asc(taskInvitations.createdAt));
  const qs = await db
    .select({ id: quotes.id, providerProfileId: quotes.providerProfileId, status: quotes.status })
    .from(quotes)
    .where(eq(quotes.taskId, taskId))
    .orderBy(desc(quotes.createdAt));
  return c.json({
    invitations: rows.map((r) => {
      const q = qs.find((x) => x.providerProfileId === r.providerProfileId);
      return { ...r, quoteId: q?.id ?? null, quoteStatus: q?.status ?? null };
    }),
  });
});

threadRoutes.get("/:id/messages", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const th = await resolveThread(db, taskId, userId, c.req.query("provider"));
  const [conv] = await db.select({ id: conversations.id }).from(conversations)
    .where(and(eq(conversations.contextType, "private"), eq(conversations.contextId, th.contextId))).limit(1);
  if (!conv) return c.json({ messages: [] });
  const rows = await db
    .select({ id: messages.id, text: messages.originalText, language: messages.originalLanguage, senderUserId: messages.senderUserId, senderName: users.displayName, createdAt: messages.createdAt })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderUserId))
    .where(eq(messages.conversationId, conv.id))
    .orderBy(desc(messages.createdAt))
    .limit(200);
  return c.json({ messages: rows.reverse().map((m) => ({ ...m, mine: m.senderUserId === userId, senderUserId: undefined })) });
});

const sendBody = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  provider: z.uuid().optional(),
  clientMessageId: z.string().trim().min(1).max(100).optional(),
});

threadRoutes.post("/:id/messages", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(sendBody, raw);

  return runIdempotent(c, { scope: "tasks.send_message", userId, body: raw }, async (tx) => {
    const th = await resolveThread(tx, taskId, userId, b.provider);
    const [me] = await tx.select({ lang: users.preferredLanguage }).from(users).where(eq(users.id, userId)).limit(1);
    if (!me) throw new ApiError(401, "unauthorized", "Missing or invalid credentials");

    await tx.insert(conversations)
      .values({ projectId: th.projectId, contextType: "private", contextId: th.contextId })
      .onConflictDoNothing();
    const [conv] = await tx.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.contextType, "private"), eq(conversations.contextId, th.contextId))).limit(1);
    if (!conv) throw new ApiError(500, "internal", "Conversation missing");
    await tx.insert(conversationParticipants).values({ conversationId: conv.id, userId }).onConflictDoNothing();

    const [row] = await tx.insert(messages).values({
      conversationId: conv.id, projectId: th.projectId, taskId, senderUserId: userId,
      originalText: b.text, originalLanguage: me.lang, clientMessageId: b.clientMessageId ?? null,
    }).returning({ id: messages.id, createdAt: messages.createdAt });
    const [prov] = await tx.select({ userId: providerProfiles.userId }).from(providerProfiles).where(eq(providerProfiles.id, th.providerProfileId)).limit(1);
    const toProvider = prov !== undefined && prov.userId !== userId;
    await notify(tx, toProvider ? [prov.userId] : await managerUserIds(tx, th.projectId), "message.received", { projectId: th.projectId, taskId, providerProfileId: th.providerProfileId, audience: toProvider ? "provider" : "manager" }, userId);
    return { status: 201, body: { message: { id: row.id, createdAt: row.createdAt } } };
  });
});
