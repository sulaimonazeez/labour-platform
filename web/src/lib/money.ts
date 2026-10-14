/** Digits after the decimal point for a currency, taken from the currency itself (never assumed to be 2). */
export function exponentOf(currency: string): number {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}

export function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 10 ** exponentOf(currency));
  } catch { return `${minor} ${currency}`; }
}

/** "12,500.50" -> minor units, or null when it is not a clean non-negative amount. */
export function toMinor(input: string, currency: string): number | null {
  const s = input.replace(/[\s,]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s) * 10 ** exponentOf(currency));
  return Number.isSafeInteger(n) ? n : null;
}
