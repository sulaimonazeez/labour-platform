import { and, eq } from "drizzle-orm";
import { organisationMembers, type orgRole } from "../db/schema/index.js";
import type { Executor } from "../db/types.js";
import { ApiError } from "../api/http.js";

export type OrgRole = (typeof orgRole.enumValues)[number];

/** The caller must belong to the organisation (optionally with one of `allowed`), else 403. */
export async function requireOrgMember(
  ex: Executor,
  organisationId: string,
  userId: string,
  allowed?: readonly OrgRole[],
): Promise<OrgRole[]> {
  const rows = await ex
    .select({ role: organisationMembers.role })
    .from(organisationMembers)
    .where(and(eq(organisationMembers.organisationId, organisationId), eq(organisationMembers.userId, userId)));
  const roles = rows.map((r) => r.role);
  if (roles.length === 0 || (allowed && !roles.some((r) => allowed.includes(r)))) {
    throw new ApiError(403, "forbidden", "You are not allowed to act for this organisation");
  }
  return roles;
}
