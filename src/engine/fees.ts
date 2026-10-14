// Platform fee calculation (PRD §50, §146). Pure and deterministic: rules come from platform_fee_rules.
// Money is integer minor units; the math uses BigInt so large amounts cannot lose precision.

export type FeeRule = {
  marketId: string | null;
  categoryId: string | null;
  basisPoints: number;
  minFeeMinor: number | null;
  maxFeeMinor: number | null;
  currency: string | null;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
};

/**
 * Most specific applicable rule: a market match beats a global rule, a currency match beats "any currency",
 * ties go to the later effective_from. Category-specific rules are not applied yet (categoryId must be null).
 */
export function pickFeeRule(
  rules: readonly FeeRule[],
  ctx: { marketId: string | null; currency: string; today: string },
): FeeRule | null {
  let best: { rule: FeeRule; score: number } | null = null;
  for (const r of rules) {
    if (r.categoryId !== null) continue;
    if (r.effectiveFrom > ctx.today) continue;
    if (r.effectiveTo !== null && r.effectiveTo < ctx.today) continue;
    if (r.marketId !== null && r.marketId !== ctx.marketId) continue;
    if (r.currency !== null && r.currency !== ctx.currency) continue;
    const score = (r.marketId !== null ? 2 : 0) + (r.currency !== null ? 1 : 0);
    if (!best || score > best.score || (score === best.score && r.effectiveFrom > best.rule.effectiveFrom)) {
      best = { rule: r, score };
    }
  }
  return best ? best.rule : null;
}

/** Fee in minor units: basis points, rounded half up, clamped to the rule's min/max (when it names a currency), never above the amount. */
export function computeFeeMinor(amountMinor: number, rule: FeeRule | null, currency: string): number {
  if (!rule || amountMinor <= 0) return 0;
  let fee = (BigInt(amountMinor) * BigInt(rule.basisPoints) + 5000n) / 10000n;
  if (rule.currency === currency) {
    if (rule.minFeeMinor !== null && fee < BigInt(rule.minFeeMinor)) fee = BigInt(rule.minFeeMinor);
    if (rule.maxFeeMinor !== null && fee > BigInt(rule.maxFeeMinor)) fee = BigInt(rule.maxFeeMinor);
  }
  if (fee > BigInt(amountMinor)) fee = BigInt(amountMinor);
  return Number(fee);
}
