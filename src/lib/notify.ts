import { and, eq, inArray } from "drizzle-orm";
import { notifications, projectMembers, users } from "../db/schema/index.js";
import type { Executor } from "../db/types.js";
import { PROJECT_MANAGERS } from "../authz/projects.js";

// PRD §112-113: in-app notifications, written inside the caller's transaction so a rolled-back action never notifies.
// The row carries a machine `kind` and ids only; wording is rendered by the client in the user's language (PRD §113).
// Push / email / SMS channels, quiet hours and per-channel preferences are NOT built (see docs/PRD_COVERAGE.md).
export async function notify(
  ex: Executor,
  userIds: readonly string[],
  kind: string,
  payload: Record<string, unknown>,
  exceptUserId?: string,
): Promise<void> {
  const ids = [...new Set(userIds)].filter((id) => id !== exceptUserId);
  if (ids.length === 0) return;
  const langs = await ex.select({ id: users.id, lang: users.preferredLanguage }).from(users).where(inArray(users.id, ids));
  if (langs.length === 0) return;
  await ex.insert(notifications).values(
    langs.map((u) => ({ userId: u.id, kind, channel: "in_app" as const, language: u.lang, payload, status: "sent" as const, sentAt: new Date() })),
  );
}

export async function managerUserIds(ex: Executor, projectId: string): Promise<string[]> {
  const rows = await ex
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.role, [...PROJECT_MANAGERS])));
  return [...new Set(rows.map((r) => r.userId))];
}
