import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { db } from "../db/client";
import { rateLimitHits } from "../db/schema";
import { err } from "../api/http";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const disabled = () => process.env.RATE_LIMIT_DISABLED === "1";

/**
 * Atomically count one hit for `key` in the current fixed window.
 * Returns whether the caller is still within `limit`, and seconds until the window resets.
 */
export async function checkLimit(key: string, limit: number, windowSec: number) {
  const windowMs = windowSec * 1000;
  const startMs = Math.floor(Date.now() / windowMs) * windowMs;
  const [row] = await db
    .insert(rateLimitHits)
    .values({ key, windowStart: new Date(startMs), count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitHits.key, rateLimitHits.windowStart],
      set: { count: sql`${rateLimitHits.count} + 1` },
    })
    .returning({ count: rateLimitHits.count });

  // Opportunistic cleanup so the table cannot grow without bound.
  if (Math.random() < 0.02) {
    await db.delete(rateLimitHits).where(lt(rateLimitHits.windowStart, new Date(Date.now() - 24 * 60 * 60 * 1000)));
  }

  return {
    ok: row.count <= limit,
    retryAfterSec: Math.max(1, Math.ceil((startMs + windowMs - Date.now()) / 1000)),
  };
}

// Behind Vercel / a reverse proxy the first X-Forwarded-For entry is the client.
// If the API is ever exposed directly (no proxy), this header is client-controlled: put a proxy in front.
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || c.req.header("x-real-ip") || "unknown";
}

export const tooMany = (c: Context, retryAfterSec: number) => {
  c.header("Retry-After", String(retryAfterSec));
  return c.json(err("rate_limited", "Too many requests. Try again later."), 429);
};

/** Per-IP limiter middleware. */
export const rateLimitByIp = (name: string, limit: number, windowSec: number) =>
  createMiddleware(async (c, next) => {
    if (disabled()) return next();
    const r = await checkLimit(`${name}:ip:${clientIp(c)}`, limit, windowSec);
    if (!r.ok) return tooMany(c, r.retryAfterSec);
    await next();
  });
