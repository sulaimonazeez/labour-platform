import { ApiError } from "../api/http";

// Until a real admin model exists (roles, MFA, audit UI), platform staff are an ALLOWLIST of user ids in the
// environment: PLATFORM_ADMIN_USER_IDS=<uuid>,<uuid>. Read on every call, so changing it needs no code change.
// Anyone else gets 404 (the admin surface does not announce itself).
export function isPlatformAdmin(userId: string): boolean {
  return (process.env.PLATFORM_ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(userId);
}
export function requirePlatformAdmin(userId: string): void {
  if (!isPlatformAdmin(userId)) throw new ApiError(404, "not_found", "Not found");
}
