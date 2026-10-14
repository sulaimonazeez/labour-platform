import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, type Db } from "../db/client.js";
import { sessions, users } from "../db/schema/index.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(tx: Tx, userId: string, userAgent: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await tx.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt, userAgent });
  return { token, expiresAt };
}

export async function verifySession(token: string) {
  const [row] = await db
    .select({ sessionId: sessions.id, userId: users.id, status: users.status })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || row.status !== "active") return null;
  return { sessionId: row.sessionId, userId: row.userId };
}

export async function revokeSession(sessionId: string) {
  await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}
