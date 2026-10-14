import { and, eq, inArray } from "drizzle-orm";
import { assignments, projectMembers, providerProfiles, tasks, type projectRole } from "../db/schema";
import type { Executor } from "../db/types";
import { ApiError } from "../api/http";

export type ProjectRole = (typeof projectRole.enumValues)[number];

/** Roles allowed to change project structure and scope. */
export const PROJECT_MANAGERS: readonly ProjectRole[] = ["project_owner", "project_manager"];

export async function getProjectRoles(ex: Executor, projectId: string, userId: string): Promise<ProjectRole[]> {
  const rows = await ex
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return rows.map((r) => r.role);
}

/**
 * Object-level check (PRD §34, §114). Never trust a project id from the client.
 * Not a member -> 404 (do not reveal that the project exists).
 * Member without a sufficient role -> 403.
 */
export async function requireProjectRole(
  ex: Executor,
  projectId: string,
  userId: string,
  allowed?: readonly ProjectRole[],
): Promise<ProjectRole[]> {
  const roles = await getProjectRoles(ex, projectId, userId);
  if (roles.length === 0) throw new ApiError(404, "not_found", "Not found");
  if (allowed && !roles.some((r) => allowed.includes(r))) {
    throw new ApiError(403, "forbidden", "You do not have permission to do this");
  }
  return roles;
}

const PROVIDER_ROLES: readonly ProjectRole[] = ["provider", "provider_team_member"];

/** True when every role the caller holds in the project is a provider role (PRD §34). */
export function isProviderOnly(roles: readonly ProjectRole[]): boolean {
  return roles.length > 0 && roles.every((r) => PROVIDER_ROLES.includes(r));
}

/**
 * Tasks a provider-only member may see: those with one of their assignments (offered, accepted,
 * active or completed). Everything else in the project stays invisible to them (PRD §34).
 */
export async function providerVisibleTaskIds(ex: Executor, projectId: string, userId: string): Promise<string[]> {
  const rows = await ex
    .select({ taskId: assignments.taskId })
    .from(assignments)
    .innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId))
    .innerJoin(tasks, eq(tasks.id, assignments.taskId))
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(providerProfiles.userId, userId),
        inArray(assignments.status, ["offered", "accepted", "active", "completed"]),
      ),
    );
  return rows.map((r) => r.taskId);
}
