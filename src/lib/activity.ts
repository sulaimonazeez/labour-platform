import { activityEvents, type actorType } from "../db/schema/index.js";
import type { Executor } from "../db/types.js";

export type ActivityActorType = (typeof actorType.enumValues)[number];

export type ActivityInput = {
  projectId?: string | null;
  actorType?: ActivityActorType; // default "user"
  actorUserId?: string | null;
  eventType: string; // dotted, e.g. "request.created", "quote.accepted"
  subjectType: string;
  subjectId?: string | null;
  payload?: Record<string, unknown>;
};

/**
 * Append one row to the canonical activity stream (PRD §68, §133, §137).
 * ALWAYS call with the caller's transaction handle so the event commits or rolls back
 * together with the change it describes. The table is append-only (DB-enforced).
 */
export async function recordActivity(ex: Executor, e: ActivityInput): Promise<void> {
  await ex.insert(activityEvents).values({
    projectId: e.projectId ?? null,
    actorType: e.actorType ?? "user",
    actorUserId: e.actorUserId ?? null,
    eventType: e.eventType,
    subjectType: e.subjectType,
    subjectId: e.subjectId ?? null,
    payload: e.payload ?? {},
  });
}
