// PRD §45, §52: money is integer minor units, never floats. Quantities have at most 3 decimals
// (matches numeric(14,3)); the line amount is computed here, on the server, with BigInt.

export const MAX_MINOR = Number.MAX_SAFE_INTEGER;
export const QUANTITY_RE = /^\d{1,10}(\.\d{1,3})?$/;

export type LineInput = { quantity: string; unitPriceMinor: number; isOptional: boolean };

/** quantity * unit price, rounded half up to a whole minor unit. */
export function lineAmountMinor(quantity: string, unitPriceMinor: number): bigint {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(quantity);
  if (!m) throw new Error(`Invalid quantity: ${quantity}`);
  const milli = BigInt(m[1]) * 1000n + BigInt((m[2] ?? "").padEnd(3, "0"));
  return (BigInt(unitPriceMinor) * milli + 500n) / 1000n;
}

/**
 * Per-line amounts plus the total. Optional lines (PRD §52 "optional work") are priced but NOT in the total.
 * Throws RangeError when any amount or the total would not fit in a JS safe integer.
 */
export function computeQuoteAmounts(lines: readonly LineInput[]): { amounts: number[]; totalMinor: number } {
  const limit = BigInt(MAX_MINOR);
  let total = 0n;
  const amounts = lines.map((l) => {
    const a = lineAmountMinor(l.quantity, l.unitPriceMinor);
    if (a > limit) throw new RangeError("line amount too large");
    if (!l.isOptional) total += a;
    return Number(a);
  });
  if (total > limit) throw new RangeError("quote total too large");
  return { amounts, totalMinor: Number(total) };
}
