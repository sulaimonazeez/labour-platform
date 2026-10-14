import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { featureFlags } from "../db/schema";
import type { Executor } from "../db/types";

// PRD §151: capabilities switch on by market, organisation, category and rollout cohort.
// A flag that does not exist is ON, so adding a flag is how you restrict something, not how you enable it.
export type FlagContext = { userId?: string; marketCode?: string; organisationId?: string; categoryKey?: string };

function bucket(key: string, userId: string): number {
  const h = createHash("sha1").update(`${key}:${userId}`).digest();
  return h.readUInt16BE(0) % 100;
}

export async function isFeatureOn(ex: Executor, key: string, ctx: FlagContext = {}): Promise<boolean> {
  const [f] = await ex.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
  if (!f) return true;
  if (!f.enabled) return false;
  const s = f.scope ?? {};
  if (s.markets && s.markets.length > 0 && !(ctx.marketCode && s.markets.includes(ctx.marketCode))) return false;
  if (s.organisations && s.organisations.length > 0 && !(ctx.organisationId && s.organisations.includes(ctx.organisationId))) return false;
  if (s.categories && s.categories.length > 0 && !(ctx.categoryKey && s.categories.includes(ctx.categoryKey))) return false;
  if (typeof s.rolloutPercent === "number" && s.rolloutPercent < 100) {
    if (!ctx.userId) return false;
    return bucket(key, ctx.userId) < s.rolloutPercent;
  }
  return true;
}
