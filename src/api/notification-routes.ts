import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { notifications } from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { runIdempotent } from "../lib/idempotency";
import { ApiError, readJson, uuidParam } from "./http";

// PRD §112: the in-app inbox.  GET /notifications, POST /notifications/:id/read, POST /notifications/read-all
export const notificationRoutes = new Hono<AuthEnv>();
notificationRoutes.use("*", requireAuth);

notificationRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const rows = await db
    .select({ id: notifications.id, kind: notifications.kind, payload: notifications.payload, createdAt: notifications.createdAt, readAt: notifications.readAt })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.channel, "in_app")))
    .orderBy(desc(notifications.createdAt))
    .limit(50);
  const [u] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.channel, "in_app"), isNull(notifications.readAt)));
  return c.json({ notifications: rows, unread: u?.n ?? 0 });
});

notificationRoutes.post("/read-all", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  return runIdempotent(c, { scope: "notifications.read_all", userId, body: raw ?? {} }, async (tx) => {
    const done = await tx
      .update(notifications)
      .set({ status: "read", readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return { status: 200, body: { marked: done.length } };
  });
});

notificationRoutes.post("/:id/read", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  return runIdempotent(c, { scope: "notifications.read", userId, body: { id, raw: raw ?? {} } }, async (tx) => {
    const [row] = await tx.select({ id: notifications.id, readAt: notifications.readAt }).from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId))).limit(1);
    if (!row) throw new ApiError(404, "not_found", "Not found"); // someone else's notification looks like a missing one
    if (!row.readAt) await tx.update(notifications).set({ status: "read", readAt: new Date() }).where(eq(notifications.id, id));
    return { status: 200, body: { id, read: true } };
  });
});
