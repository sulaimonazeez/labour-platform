import { platformEvents } from "../db/schema/index.js";
import type { Executor } from "../db/types.js";

/** PRD §150: operational signals (AI, translation, payment, upload, SLA, fraud) land in one queryable table. Never throws. */
export async function logEvent(ex: Executor, kind: string, severity: "info" | "warn" | "error", payload: Record<string, unknown> = {}): Promise<void> {
  try {
    await ex.insert(platformEvents).values({ kind, severity, payload });
  } catch {
    // Observability must never break the request it observes.
  }
}
