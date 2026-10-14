// Pure comparison of the gateway's transaction list against our payments (no I/O: unit-tested). PRD §150.
// The runner is src/dev/reconcile-paystack.ts (`npm run reconcile`). Read-only: it never changes anything.

export type GatewayTx = { reference: string; status: "success" | "failed" | "pending"; amountMinor: number; currency: string };
export type OurPayment = { id: string; providerReference: string | null; state: string; amountMinor: number; currency: string; hasCaptureEntry: boolean };

export type DiscrepancyKind =
  | "unknown_at_our_side"          // gateway took money for a reference we have no payment for
  | "paid_but_not_secured"         // gateway says success, our payment is still pending/created (run verify)
  | "paid_after_expiry"            // gateway says success, our payment was closed as failed (late success: check suspense)
  | "amount_mismatch"              // both say paid but the amount/currency differ
  | "secured_not_paid_at_gateway"  // we hold money the gateway does not show as successful
  | "secured_without_ledger_entry";// payment is past `secured` but there is no capture entry in the ledger

export type Discrepancy = { kind: DiscrepancyKind; reference: string | null; paymentId: string | null; detail: string };

const MONEY_HELD = new Set(["secured", "partially_released", "released", "refunded", "partially_refunded", "disputed", "chargeback"]);

/** `referencePrefix`: only references we generated (lp_...) are our business; anything else on the account is ignored. */
export function reconcile(gateway: readonly GatewayTx[], ours: readonly OurPayment[], opts: { referencePrefix?: string } = {}): Discrepancy[] {
  const prefix = opts.referencePrefix ?? "lp_";
  const out: Discrepancy[] = [];
  const mine = new Map<string, OurPayment>();
  for (const p of ours) if (p.providerReference) mine.set(p.providerReference, p);
  const theirs = new Map<string, GatewayTx>();
  for (const t of gateway) theirs.set(t.reference, t);

  for (const t of gateway) {
    if (t.status !== "success" || !t.reference.startsWith(prefix)) continue;
    const p = mine.get(t.reference);
    if (!p) {
      out.push({ kind: "unknown_at_our_side", reference: t.reference, paymentId: null, detail: `Gateway shows ${t.amountMinor} ${t.currency} paid; we have no such payment` });
    } else if (p.state === "pending" || p.state === "created") {
      out.push({ kind: "paid_but_not_secured", reference: t.reference, paymentId: p.id, detail: `Paid at the gateway but our payment is ${p.state}: run POST /payments/:id/verify` });
    } else if (p.state === "failed") {
      out.push({ kind: "paid_after_expiry", reference: t.reference, paymentId: p.id, detail: "Paid after we closed the checkout: money should be in suspense; refund or reassign it" });
    } else if (p.amountMinor !== t.amountMinor || p.currency !== t.currency) {
      out.push({ kind: "amount_mismatch", reference: t.reference, paymentId: p.id, detail: `We expect ${p.amountMinor} ${p.currency}, gateway shows ${t.amountMinor} ${t.currency}` });
    }
  }
  for (const p of ours) {
    if (!MONEY_HELD.has(p.state)) continue;
    const t = p.providerReference ? theirs.get(p.providerReference) : undefined;
    if (!t || t.status !== "success") {
      out.push({ kind: "secured_not_paid_at_gateway", reference: p.providerReference, paymentId: p.id, detail: `We hold this payment (${p.state}) but the gateway does not list it as successful in this window` });
    }
    if (!p.hasCaptureEntry) {
      out.push({ kind: "secured_without_ledger_entry", reference: p.providerReference, paymentId: p.id, detail: `Payment is ${p.state} but has no payment_captured ledger entry` });
    }
  }
  return out;
}
