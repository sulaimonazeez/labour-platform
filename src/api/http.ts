import { z } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const err = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

// Drizzle 0.44+ wraps driver errors; the SQLSTATE lives on the error or somewhere down its cause chain.
export function pgErrorCode(e: unknown): string | undefined {
  let cur: any = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause;
  }
  return undefined;
}

/**
 * Throw from anywhere (including inside a transaction: it rolls back) to return a
 * `{ error: { code, message, details? } }` body with this status. Handled in `app.onError`.
 */
export class ApiError extends Error {
  status: ContentfulStatusCode;
  code: string;
  details?: unknown;
  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Finds an ApiError even if a driver/ORM layer wrapped it. */
export function asApiError(e: unknown): ApiError | null {
  let cur: any = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof ApiError) return cur;
    cur = cur.cause;
  }
  return null;
}

export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ApiError(
      400,
      "validation_error",
      "Invalid request",
      r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return r.data;
}

const uuidSchema = z.uuid();
/** Malformed ids are "not found", never a database error. */
export function uuidParam(value: string | undefined): string {
  const r = uuidSchema.safeParse(value);
  if (!r.success) throw new ApiError(404, "not_found", "Not found");
  return r.data;
}

export const isIanaTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => null);
}
