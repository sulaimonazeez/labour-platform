import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import type { Tx } from "../auth/session";
import { ApiError } from "../api/http";

// PRD §136. Design (DECISIONS D20):
//  - The key row is claimed INSIDE the same transaction as the business write, and the response is
//    stored in that same transaction. So either everything commits (effect + key + response) or nothing does.
//  - Two concurrent requests with one key: the second INSERT blocks on the first's uncommitted row,
//    then (after commit) finds the stored response and replays it. After a rollback it simply runs.
//  - Scope is "<operation>:<userId>": keys never collide across users or operations.
//  - Only successful (2xx) results are stored. Any thrown error rolls the key back, so a corrected retry can reuse it.

const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** JSON with sorted keys, so the same logical body always hashes the same. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const parts = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`);
  return `{${parts.join(",")}}`;
}

export function idempotencyKey(c: Context): string {
  const k = c.req.header("idempotency-key")?.trim();
  if (!k) throw new ApiError(400, "idempotency_key_required", "The Idempotency-Key header is required");
  if (!KEY_RE.test(k)) {
    throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 8-200 characters: letters, digits, _ . : -");
  }
  return k;
}

export type IdempotentResult = { status: 200 | 201; body: Record<string, unknown> };

export async function runIdempotent(
  c: Context,
  opts: { scope: string; userId: string; body: unknown },
  handler: (tx: Tx) => Promise<IdempotentResult>,
): Promise<Response> {
  const key = idempotencyKey(c);
  const scope = `${opts.scope}:${opts.userId}`;
  const requestHash = sha256(`${c.req.method} ${c.req.path}\n${stableStringify(opts.body ?? null)}`);
  const match = and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key));

  const out = await db.transaction(async (tx) => {
    const claimed = await tx
      .insert(idempotencyKeys)
      .values({ scope, key, requestHash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (claimed.length === 0) {
      const [row] = await tx
        .select({ requestHash: idempotencyKeys.requestHash, status: idempotencyKeys.responseStatus, body: idempotencyKeys.responseBody })
        .from(idempotencyKeys)
        .where(match)
        .limit(1);
      if (!row || row.status === null || row.body === null) {
        throw new ApiError(409, "request_in_progress", "A request with this Idempotency-Key is still in progress; retry shortly");
      }
      if (row.requestHash !== requestHash) {
        throw new ApiError(422, "idempotency_key_reuse", "This Idempotency-Key was already used with a different request");
      }
      return { replayed: true, status: row.status, body: row.body as Record<string, unknown> };
    }

    const result = await handler(tx);
    // Round-trip through JSON so the first response and every replay are byte-identical (Dates -> ISO strings).
    const body = JSON.parse(JSON.stringify(result.body)) as Record<string, unknown>;
    await tx.update(idempotencyKeys).set({ responseStatus: result.status, responseBody: body }).where(match);
    return { replayed: false, status: result.status as number, body };
  });

  if (out.replayed) c.header("Idempotent-Replayed", "true");
  return c.json(out.body, out.status as ContentfulStatusCode);
}
