import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import { markets, payouts, providerPayoutAccounts, providerProfiles, users } from "../db/schema/index.js";
import type { Executor } from "../db/types.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { recordActivity } from "../lib/activity.js";
import { idempotencyKey, runIdempotent } from "../lib/idempotency.js";
import { accountCooldownMs, callGateway, payoutCols, payoutGateway, payoutMinMinor, providerBalance, reservePayout } from "../payments/payouts.js";
import { ApiError, parseOrThrow, readJson } from "./http.js";

// Provider side of payouts (mounted at /providers). Admin approval and sending live in admin-routes.ts.
//   GET  /providers/banks?currency=NGN        PUT /providers/me/payout-account     GET /providers/me/payout-account
//   GET  /providers/me/balance?currency=NGN   POST /providers/me/payouts           GET /providers/me/payouts

const currencySchema = z.string().trim().toUpperCase().length(3);
const accountBody = z.strictObject({
  bankCode: z.string().trim().regex(/^[A-Za-z0-9_-]{2,20}$/),
  accountNumber: z.string().trim().regex(/^\d{6,20}$/),
  currency: currencySchema,
});
const requestBody = z.strictObject({
  amountMinor: z.number().int().positive().max(1_000_000_000_000),
  currency: currencySchema,
});

async function myProvider(ex: Executor, userId: string) {
  const [p] = await ex.select({ id: providerProfiles.id, displayName: providerProfiles.displayName, isActive: providerProfiles.isActive })
    .from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
  if (!p || !p.isActive) throw new ApiError(404, "not_found", "You have no provider profile");
  return p;
}

const accountView = (a: { bankCode: string; accountLast4: string; accountName: string; currency: string; updatedAt: Date }) => ({
  bankCode: a.bankCode,
  accountLast4: a.accountLast4,
  accountName: a.accountName,
  currency: a.currency,
  updatedAt: a.updatedAt,
  payoutsPausedUntil: new Date(a.updatedAt.getTime() + accountCooldownMs()),
});

export const providerPayoutRoutes = new Hono<AuthEnv>();
providerPayoutRoutes.use("*", requireAuth);

providerPayoutRoutes.get("/banks", async (c) => {
  // PRD §2/§45: no hard-coded currency. Without ?currency= we use the signed-in user's own market (D71).
  let requested = c.req.query("currency");
  if (!requested) {
    const [m] = await db.select({ cur: markets.defaultCurrency }).from(users).innerJoin(markets, eq(markets.id, users.marketId)).where(eq(users.id, c.get("auth").userId)).limit(1);
    if (!m) throw new ApiError(400, "currency_required", "Say which currency (?currency=XXX): your account has no market yet");
    requested = m.cur;
  }
  const currency = parseOrThrow(currencySchema, requested);
  const { gw } = payoutGateway();
  const banks = await callGateway(() => gw.listBanks(currency));
  return c.json({ currency, banks });
});

providerPayoutRoutes.get("/me/payout-account", async (c) => {
  const me = await myProvider(db, c.get("auth").userId);
  const [a] = await db.select().from(providerPayoutAccounts).where(eq(providerPayoutAccounts.providerProfileId, me.id)).limit(1);
  if (!a) throw new ApiError(404, "not_found", "No payout account yet");
  return c.json({ payoutAccount: accountView(a) });
});

// Set or replace the account. The bank resolves the account NAME (shown back so a typo is caught); the full number is never stored.
providerPayoutRoutes.put("/me/payout-account", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(accountBody, raw);

  return runIdempotent(c, { scope: "payout_account.set", userId, body: raw }, async (tx) => {
    const me = await myProvider(tx, userId);
    await tx.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.id, me.id)).for("update");
    const { providerCode, gw } = payoutGateway();

    const open = await tx.select({ id: payouts.id }).from(payouts)
      .where(and(eq(payouts.providerProfileId, me.id), inArray(payouts.state, ["pending", "processing"]))).limit(1);
    if (open.length > 0) throw new ApiError(409, "payouts_in_flight", "You cannot change the payout account while a payout is pending or processing");

    const { accountName } = await callGateway(() => gw.resolveAccount({ accountNumber: b.accountNumber, bankCode: b.bankCode }), "Account check");
    const { recipientCode } = await callGateway(() => gw.createRecipient({ name: accountName, accountNumber: b.accountNumber, bankCode: b.bankCode, currency: b.currency }), "Creating the payout recipient");

    const values = { providerCode, currency: b.currency, bankCode: b.bankCode, accountLast4: b.accountNumber.slice(-4), accountName, recipientCode, updatedAt: new Date() };
    const [existing] = await tx.select({ id: providerPayoutAccounts.id }).from(providerPayoutAccounts).where(eq(providerPayoutAccounts.providerProfileId, me.id)).limit(1);
    const [row] = existing
      ? await tx.update(providerPayoutAccounts).set(values).where(eq(providerPayoutAccounts.id, existing.id)).returning()
      : await tx.insert(providerPayoutAccounts).values({ providerProfileId: me.id, ...values }).returning();

    await recordActivity(tx, {
      actorUserId: userId, eventType: "payout_account.set", subjectType: "provider_profile", subjectId: me.id,
      payload: { replaced: Boolean(existing), bankCode: b.bankCode, accountLast4: values.accountLast4, currency: b.currency },
    });
    return { status: 200, body: { payoutAccount: accountView(row) } };
  });
});

providerPayoutRoutes.get("/me/balance", async (c) => {
  const me = await myProvider(db, c.get("auth").userId);
  const currency = parseOrThrow(currencySchema, c.req.query("currency") ?? "");
  return c.json({ balance: await providerBalance(db, me.id, currency), minimumPayoutMinor: payoutMinMinor() });
});

providerPayoutRoutes.get("/me/payouts", async (c) => {
  const me = await myProvider(db, c.get("auth").userId);
  const rows = await db.select(payoutCols).from(payouts).where(eq(payouts.providerProfileId, me.id)).orderBy(desc(payouts.createdAt)).limit(100);
  return c.json({ payouts: rows });
});

// Reserves the earnings and creates a PENDING payout. Nothing is sent until a platform admin approves it.
providerPayoutRoutes.post("/me/payouts", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(requestBody, raw);
  const key = idempotencyKey(c);

  return runIdempotent(c, { scope: "payouts.request", userId, body: raw }, async (tx) => {
    const me = await myProvider(tx, userId);
    const { providerCode } = payoutGateway();
    const row = await reservePayout(tx, {
      userId, providerProfileId: me.id, providerCode, amountMinor: b.amountMinor, currency: b.currency,
      idempotencyKey: `payouts.request:${userId}:${key}`,
    });
    return { status: 201, body: { payout: row } };
  });
});
