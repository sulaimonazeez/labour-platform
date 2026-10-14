import { and, eq, sql } from "drizzle-orm";
import { ApiError } from "../api/http.js";
import { db } from "../db/client.js";
import { activityEvents, payouts, providerPayoutAccounts, providerProfiles } from "../db/schema/index.js";
import type { Executor } from "../db/types.js";
import { recordActivity, type ActivityActorType } from "../lib/activity.js";
import { getPaymentProvider } from "./index.js";
import { accountBalance, postEntry } from "./ledger.js";
import { ProviderError, type PayoutGateway, type TransferVerify } from "./provider.js";

// Money OUT (PRD §125; DECISIONS D55-D58). Ledger flow for one payout:
//   request   : provider_earnings -> payout_clearing            (earnings are RESERVED; key payout:<id>:reserved)
//   success   : payout_clearing   -> external_clearing (credit) (money left the platform; key payout:<id>:paid)
//   failure   : payout_clearing   -> provider_earnings          (reservation returned;  key payout:<id>:returned)
// A reservation ends exactly once: the state guards (processing -> paid|failed, pending -> cancelled) plus the fixed
// idempotency keys make a double release impossible. EVERY payout needs a platform admin's approval (no auto-pay).
// Two-phase transfer: (1) commit "processing" + the gateway reference, (2) call the gateway OUTSIDE any transaction,
// (3) apply the result. A crash between 1 and 3 leaves a verifiable `processing` payout, never lost or duplicated money.

export const payoutCols = {
  id: payouts.id,
  providerProfileId: payouts.providerProfileId,
  amountMinor: payouts.amountMinor,
  currency: payouts.currency,
  state: payouts.state,
  providerCode: payouts.providerCode,
  providerReference: payouts.providerReference,
  failureReason: payouts.failureReason,
  approvedAt: payouts.approvedAt,
  createdAt: payouts.createdAt,
  updatedAt: payouts.updatedAt,
};

export type PayoutRow = { id: string; providerProfileId: string; amountMinor: number; currency: string; state: string; providerCode: string; providerReference: string | null };

export function payoutMinMinor(): number {
  const n = Number(process.env.PAYOUT_MIN_MINOR ?? 10_000); // NGN 100.00
  return Number.isSafeInteger(n) && n > 0 ? n : 10_000;
}
export function accountCooldownMs(): number {
  const h = Number(process.env.PAYOUT_ACCOUNT_COOLDOWN_HOURS ?? 24);
  return (Number.isFinite(h) && h >= 0 ? h : 24) * 3_600_000;
}
export const transferReference = (payoutId: string) => `lpo_${payoutId.replaceAll("-", "")}`;
/** After this long, a `processing` payout the gateway has never heard of may be failed by a human. */
const NOT_FOUND_GRACE_MS = 10 * 60_000;

export function payoutGateway(): { providerCode: string; gw: PayoutGateway } {
  const p = getPaymentProvider();
  if (!p.payouts) throw new ApiError(503, "payouts_not_supported", "The configured payment provider cannot make payouts");
  return { providerCode: p.code, gw: p.payouts };
}

/** `context` says WHICH gateway step failed ("Account check", "Creating the payout recipient"...) so the error is diagnosable. */
export async function callGateway<T>(fn: () => Promise<T>, context?: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProviderError) throw new ApiError(502, "payment_provider_error", context ? `${context}: ${e.message}` : e.message);
    throw e;
  }
}

export async function providerBalance(ex: Executor, providerProfileId: string, currency: string) {
  const owner = `provider:${providerProfileId}`;
  const availableMinor = await accountBalance(ex, "provider_earnings", owner, currency);
  const inTransitMinor = await accountBalance(ex, "payout_clearing", owner, currency);
  const [r] = await ex
    .select({ v: sql<string>`coalesce(sum(${payouts.amountMinor}), 0)::text` })
    .from(payouts)
    .where(and(eq(payouts.providerProfileId, providerProfileId), eq(payouts.currency, currency), eq(payouts.state, "paid")));
  return { currency, availableMinor, inTransitMinor, paidOutMinor: Number(r?.v ?? 0) };
}

export type Actor = { actorType: ActivityActorType; userId: string | null };

/** Provider asks to be paid: validates, then RESERVES the earnings. Runs inside the caller's transaction. */
export async function reservePayout(
  tx: Executor,
  i: { userId: string; providerProfileId: string; providerCode: string; amountMinor: number; currency: string; idempotencyKey: string },
) {
  // Serialise payout requests per provider: two parallel requests cannot both spend the same earnings.
  await tx.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.id, i.providerProfileId)).for("update");

  const [acct] = await tx
    .select({ providerCode: providerPayoutAccounts.providerCode, currency: providerPayoutAccounts.currency, updatedAt: providerPayoutAccounts.updatedAt })
    .from(providerPayoutAccounts)
    .where(eq(providerPayoutAccounts.providerProfileId, i.providerProfileId))
    .limit(1);
  if (!acct || acct.providerCode !== i.providerCode) {
    throw new ApiError(409, "payout_account_required", "Add a payout account before requesting a payout");
  }
  if (acct.currency !== i.currency) throw new ApiError(409, "payout_account_currency_mismatch", `Your payout account is in ${acct.currency}`);
  const availableAt = new Date(acct.updatedAt.getTime() + accountCooldownMs());
  if (availableAt.getTime() > Date.now()) {
    throw new ApiError(409, "payout_account_recently_changed", "Payouts are paused for a while after the payout account changes", { availableAt: availableAt.toISOString() });
  }
  if (i.amountMinor < payoutMinMinor()) throw new ApiError(400, "below_minimum", "The amount is below the minimum payout", { minMinor: payoutMinMinor() });

  const bal = await providerBalance(tx, i.providerProfileId, i.currency);
  if (bal.availableMinor < i.amountMinor) {
    throw new ApiError(409, "insufficient_earnings", "Your available earnings do not cover this payout", { availableMinor: bal.availableMinor });
  }

  const [row] = await tx
    .insert(payouts)
    .values({ providerProfileId: i.providerProfileId, amountMinor: i.amountMinor, currency: i.currency, state: "pending", providerCode: i.providerCode, idempotencyKey: i.idempotencyKey })
    .returning(payoutCols);

  await postEntry(tx, {
    kind: "payout",
    payoutId: row.id,
    description: "Payout requested: earnings reserved",
    idempotencyKey: `payout:${row.id}:reserved`,
    lines: [
      { account: "provider_earnings", ownerKey: `provider:${i.providerProfileId}`, direction: "debit", amountMinor: i.amountMinor, currency: i.currency },
      { account: "payout_clearing", ownerKey: `provider:${i.providerProfileId}`, direction: "credit", amountMinor: i.amountMinor, currency: i.currency },
    ],
  });
  await recordActivity(tx, {
    actorUserId: i.userId, eventType: "payout.requested", subjectType: "payout", subjectId: row.id,
    payload: { providerProfileId: i.providerProfileId, amountMinor: i.amountMinor, currency: i.currency },
  });
  return row;
}

async function lockPayout(tx: Executor, id: string) {
  const [p] = await tx.select(payoutCols).from(payouts).where(eq(payouts.id, id)).limit(1).for("update");
  if (!p) throw new ApiError(404, "not_found", "Not found");
  return p;
}

async function returnReservation(tx: Executor, p: { id: string; providerProfileId: string; amountMinor: number; currency: string }, description: string) {
  await postEntry(tx, {
    kind: "payout",
    payoutId: p.id,
    description,
    idempotencyKey: `payout:${p.id}:returned`,
    lines: [
      { account: "payout_clearing", ownerKey: `provider:${p.providerProfileId}`, direction: "debit", amountMinor: p.amountMinor, currency: p.currency },
      { account: "provider_earnings", ownerKey: `provider:${p.providerProfileId}`, direction: "credit", amountMinor: p.amountMinor, currency: p.currency },
    ],
  });
}

/** Admin rejects a payout nobody has sent yet (pending -> cancelled) and the earnings return to the provider. */
export async function cancelPendingPayout(tx: Executor, id: string, actor: Actor, reason: string | null) {
  const p = await lockPayout(tx, id);
  if (p.state !== "pending") throw new ApiError(409, "payout_not_pending", `Only a pending payout can be rejected (this one is ${p.state})`);
  await returnReservation(tx, p, "Payout rejected: earnings returned");
  const [row] = await tx.update(payouts).set({ state: "cancelled", failureReason: reason }).where(eq(payouts.id, id)).returning(payoutCols);
  await recordActivity(tx, { actorType: actor.actorType, actorUserId: actor.userId, eventType: "payout.cancelled", subjectType: "payout", subjectId: id, payload: { reason } });
  return row;
}

export type PayoutOutcome = "paid" | "failed" | "unchanged" | "reversal_after_paid";

/** Applies what the gateway says about a transfer. Safe to run twice or concurrently (row lock + fixed ledger keys). */
export async function applyTransferStatus(tx: Executor, id: string, v: TransferVerify, actor: Actor, opts: { failIfNotFound?: boolean } = {}) {
  const p = await lockPayout(tx, id);
  const who = { actorType: actor.actorType, actorUserId: actor.userId, subjectType: "payout", subjectId: p.id };
  const done = (outcome: PayoutOutcome, payout = p) => ({ outcome, payout });

  if (p.state === "paid") {
    if (v.found && v.status === "failed") {
      const [seen] = await tx.select({ id: activityEvents.id }).from(activityEvents)
        .where(and(eq(activityEvents.eventType, "payout.reversal_after_paid"), eq(activityEvents.subjectId, p.id))).limit(1);
      if (!seen) {
        await recordActivity(tx, { ...who, eventType: "payout.reversal_after_paid", payload: { amountMinor: p.amountMinor, currency: p.currency, note: "Gateway reports a reversal after we recorded the payout as paid. Needs manual review." } });
        return done("reversal_after_paid");
      }
    }
    return done("unchanged");
  }
  if (p.state !== "processing") return done("unchanged");

  if (!v.found) {
    if (!opts.failIfNotFound) return done("unchanged");
    return failProcessing(tx, p, who, "not_found_at_gateway");
  }
  if (v.status === "processing") return done("unchanged");
  if (v.status === "failed") return failProcessing(tx, p, who, "gateway_failed");

  await postEntry(tx, {
    kind: "payout",
    payoutId: p.id,
    description: `Payout sent via ${p.providerCode}`,
    idempotencyKey: `payout:${p.id}:paid`,
    lines: [
      { account: "payout_clearing", ownerKey: `provider:${p.providerProfileId}`, direction: "debit", amountMinor: p.amountMinor, currency: p.currency },
      { account: "external_clearing", ownerKey: `provider:${p.providerCode}`, direction: "credit", amountMinor: p.amountMinor, currency: p.currency },
    ],
  });
  const [row] = await tx.update(payouts).set({ state: "paid" }).where(eq(payouts.id, p.id)).returning(payoutCols);
  await recordActivity(tx, { ...who, eventType: "payout.paid", payload: { amountMinor: p.amountMinor, currency: p.currency, providerCode: p.providerCode } });
  return done("paid", row);
}

async function failProcessing(tx: Executor, p: Awaited<ReturnType<typeof lockPayout>>, who: { actorType: ActivityActorType; actorUserId: string | null; subjectType: string; subjectId: string }, reason: string) {
  await returnReservation(tx, p, `Payout failed (${reason}): earnings returned`);
  const [row] = await tx.update(payouts).set({ state: "failed", failureReason: reason }).where(eq(payouts.id, p.id)).returning(payoutCols);
  await recordActivity(tx, { ...who, eventType: "payout.failed", payload: { reason, amountMinor: p.amountMinor, currency: p.currency } });
  return { outcome: "failed" as PayoutOutcome, payout: row };
}

/** Phase 1 of approval: commit `processing` + the gateway reference. Nothing has left the platform yet. */
export async function beginTransfer(payoutId: string, actor: Actor, providerCode: string) {
  return db.transaction(async (tx) => {
    const p = await lockPayout(tx, payoutId);
    if (p.state !== "pending") throw new ApiError(409, "payout_not_pending", `Only a pending payout can be approved (this one is ${p.state})`);
    if (p.providerCode !== providerCode) throw new ApiError(409, "provider_mismatch", "This payout belongs to a different payment provider");
    const [acct] = await tx.select({ recipientCode: providerPayoutAccounts.recipientCode, providerCode: providerPayoutAccounts.providerCode })
      .from(providerPayoutAccounts).where(eq(providerPayoutAccounts.providerProfileId, p.providerProfileId)).limit(1);
    if (!acct || acct.providerCode !== providerCode) throw new ApiError(409, "payout_account_required", "The provider has no payout account for this gateway");
    const reference = transferReference(p.id);
    const [row] = await tx.update(payouts)
      .set({ state: "processing", providerReference: reference, approvedByUserId: actor.userId, approvedAt: new Date() })
      .where(eq(payouts.id, p.id)).returning(payoutCols);
    await recordActivity(tx, { actorType: actor.actorType, actorUserId: actor.userId, eventType: "payout.processing", subjectType: "payout", subjectId: p.id, payload: { reference, amountMinor: p.amountMinor, currency: p.currency } });
    return { payout: row, recipientCode: acct.recipientCode, reference };
  });
}

/** Phases 2+3: call the gateway (no transaction open), then apply the result. A gateway error leaves the payout `processing`. */
export async function runTransfer(gw: PayoutGateway, payout: PayoutRow, recipientCode: string, reference: string, actor: Actor) {
  let status: "processing" | "paid" | "failed" | "otp_required";
  try {
    const existing = await gw.verifyTransfer(reference); // re-entry safe: the transfer may already exist
    if (existing.found) status = existing.status;
    else status = (await gw.initiateTransfer({ reference, amountMinor: payout.amountMinor, currency: payout.currency, recipientCode, reason: "Labour platform payout" })).status;
  } catch (e) {
    if (e instanceof ProviderError) throw new ApiError(502, "payment_provider_error", `${e.message} (the payout stays 'processing'; use verify to resolve it)`, { payoutId: payout.id, state: "processing" });
    throw e;
  }
  if (status === "processing") return { outcome: "unchanged" as PayoutOutcome, payout };
  const v: TransferVerify = status === "paid"
    ? { found: true, status: "paid", amountMinor: payout.amountMinor, currency: payout.currency }
    : { found: true, status: "failed", amountMinor: payout.amountMinor, currency: payout.currency };
  const res = await db.transaction((tx) => applyTransferStatus(tx, payout.id, v, actor));
  if (status === "otp_required" && res.outcome === "failed") {
    await db.update(payouts).set({ failureReason: "otp_required: turn off transfer confirmation (OTP) in the gateway dashboard" }).where(eq(payouts.id, payout.id));
  }
  return res;
}

/** Admin "verify": ask the gateway about a processing payout and apply it. A transfer the gateway has never heard of fails after a grace period. */
export async function verifyPayout(id: string, actor: Actor) {
  const [p] = await db.select(payoutCols).from(payouts).where(eq(payouts.id, id)).limit(1);
  if (!p) throw new ApiError(404, "not_found", "Not found");
  if (p.state !== "processing" || !p.providerReference) return { outcome: "unchanged" as PayoutOutcome, payout: p, gatewayStatus: null as string | null };
  const { providerCode, gw } = payoutGateway();
  if (p.providerCode !== providerCode) throw new ApiError(409, "provider_mismatch", "This payout belongs to a different payment provider");
  const ref = p.providerReference;
  const v = await callGateway(() => gw.verifyTransfer(ref));
  const aged = Date.now() - p.updatedAt.getTime() > NOT_FOUND_GRACE_MS;
  const res = await db.transaction((tx) => applyTransferStatus(tx, p.id, v, actor, { failIfNotFound: aged }));
  return { ...res, gatewayStatus: v.found ? v.status : "not_found" };
}

/** Webhook transfer.* : never trust the body, confirm with the gateway, then apply. */
export async function handleTransferWebhook(providerCode: string, reference: string) {
  const [p] = await db.select(payoutCols).from(payouts)
    .where(and(eq(payouts.providerCode, providerCode), eq(payouts.providerReference, reference))).limit(1);
  if (!p) return { handled: false, outcome: "unknown_reference" };
  const { gw } = payoutGateway();
  const v = await callGateway(() => gw.verifyTransfer(reference));
  const res = await db.transaction((tx) => applyTransferStatus(tx, p.id, v, { actorType: "provider_webhook", userId: null }));
  return { handled: res.outcome !== "unchanged", outcome: res.outcome };
}
