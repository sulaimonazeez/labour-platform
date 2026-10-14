import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { markets, userCredentials, users } from "../db/schema";
import { burnVerify, hashPassword, verifyPassword } from "../auth/password";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { createSession, revokeSession } from "../auth/session";
import { checkLimit, rateLimitByIp, sha256, tooMany } from "../auth/rate-limit";
import { err, pgErrorCode } from "./http";

const isIana = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const registerBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(128),
  displayName: z.string().trim().min(1).max(100),
  preferredLanguage: z.string().trim().min(2).max(20),
  timezone: z.string().trim().refine(isIana, "Unknown IANA timezone"),
  marketCode: z.string().trim().min(1).max(20).optional(),
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string().min(1).max(128),
});

async function readJson(c: { req: { json: () => Promise<unknown> } }) {
  return c.req.json().catch(() => null);
}

const invalidCredentials = err("invalid_credentials", "Invalid email or password");

export const authRoutes = new Hono<AuthEnv>();

authRoutes.post("/register", rateLimitByIp("register", 10, 600), async (c) => {
  const parsed = registerBody.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json(err("validation_error", "Invalid request", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))), 400);
  }
  const b = parsed.data;

  let marketId: string | null = null;
  if (b.marketCode) {
    const [m] = await db.select({ id: markets.id }).from(markets).where(eq(markets.code, b.marketCode)).limit(1);
    if (!m) return c.json(err("unknown_market", "Unknown market code"), 400);
    marketId = m.id;
  }

  const passwordHash = await hashPassword(b.password);
  const userAgent = c.req.header("user-agent") ?? null;

  try {
    const out = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: b.email, displayName: b.displayName, preferredLanguage: b.preferredLanguage, timezone: b.timezone, marketId })
        .returning({ id: users.id, email: users.email, displayName: users.displayName, preferredLanguage: users.preferredLanguage, timezone: users.timezone, marketId: users.marketId });
      await tx.insert(userCredentials).values({ userId: u.id, passwordHash });
      const session = await createSession(tx, u.id, userAgent);
      return { user: u, ...session };
    });
    return c.json({ user: out.user, token: out.token, expiresAt: out.expiresAt }, 201);
  } catch (e) {
    const code = pgErrorCode(e);
    if (code === "23505") return c.json(err("email_taken", "An account with this email already exists"), 409);
    if (code === "23503") return c.json(err("unknown_language", "Unsupported preferredLanguage"), 400);
    throw e;
  }
});

authRoutes.post("/login", rateLimitByIp("login", 30, 600), async (c) => {
  const parsed = loginBody.safeParse(await readJson(c));
  if (!parsed.success) return c.json(err("validation_error", "Invalid request"), 400);
  const { email, password } = parsed.data;

  // Per-account limit stops password guessing spread across many IPs (and caps argon2 CPU burn per account).
  if (process.env.RATE_LIMIT_DISABLED !== "1") {
    const r = await checkLimit(`login:email:${sha256(email)}`, 10, 600);
    if (!r.ok) return tooMany(c, r.retryAfterSec);
  }

  const [row] = await db
    .select({ id: users.id, status: users.status, hash: userCredentials.passwordHash })
    .from(users)
    .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
    .where(eq(users.email, email))
    .limit(1);

  if (!row || !row.hash) {
    await burnVerify(password);
    return c.json(invalidCredentials, 401);
  }
  const ok = await verifyPassword(password, row.hash);
  if (!ok || row.status !== "active") return c.json(invalidCredentials, 401);

  const userAgent = c.req.header("user-agent") ?? null;
  const session = await db.transaction((tx) => createSession(tx, row.id, userAgent));
  return c.json({ token: session.token, expiresAt: session.expiresAt }, 200);
});

authRoutes.post("/logout", requireAuth, async (c) => {
  await revokeSession(c.get("auth").sessionId);
  return c.body(null, 204);
});
