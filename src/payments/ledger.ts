import { and, eq, sql } from "drizzle-orm";
import { ledgerAccounts, ledgerEntries, ledgerLines, type ledgerAccountKind, type ledgerEntryKind } from "../db/schema";
import type { Executor } from "../db/types";

// Double-entry posting (PRD §50). Balances are derived from lines, never stored. The database independently
// enforces: line currency = account currency, every entry balances per currency, entries/lines are append-only.

export type AccountKind = (typeof ledgerAccountKind.enumValues)[number];
export type EntryKind = (typeof ledgerEntryKind.enumValues)[number];

export type PostingLine = {
  account: AccountKind;
  ownerKey: string; // 'platform', 'project:<uuid>', 'provider:<uuid>', 'provider:paystack' (gateway clearing)
  direction: "debit" | "credit";
  amountMinor: number;
  currency: string;
};

export async function accountId(ex: Executor, kind: AccountKind, ownerKey: string, currency: string): Promise<string> {
  await ex.insert(ledgerAccounts).values({ kind, ownerKey, currency }).onConflictDoNothing();
  const [a] = await ex
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.kind, kind), eq(ledgerAccounts.ownerKey, ownerKey), eq(ledgerAccounts.currency, currency)))
    .limit(1);
  if (!a) throw new Error("ledger account missing after upsert");
  return a.id;
}

/**
 * Posts one balanced entry. Idempotent: a second call with the same idempotencyKey posts nothing and
 * returns posted:false, so retries and webhook replays can never double-post.
 */
export async function postEntry(
  ex: Executor,
  e: {
    kind: EntryKind;
    projectId?: string | null; // null for entries that belong to no project (payouts)
    milestoneId?: string | null;
    paymentId?: string | null;
    payoutId?: string | null;
    description?: string;
    idempotencyKey: string;
    lines: PostingLine[];
  },
): Promise<{ posted: boolean; entryId: string | null }> {
  if (e.lines.length < 2) throw new Error("A ledger entry needs at least two lines");
  const net = new Map<string, bigint>();
  for (const l of e.lines) {
    if (!Number.isSafeInteger(l.amountMinor) || l.amountMinor <= 0) throw new Error("Ledger line amounts must be positive integers");
    net.set(l.currency, (net.get(l.currency) ?? 0n) + (l.direction === "debit" ? 1n : -1n) * BigInt(l.amountMinor));
  }
  for (const [currency, n] of net) if (n !== 0n) throw new Error(`Ledger entry is unbalanced in ${currency}`);

  const [entry] = await ex
    .insert(ledgerEntries)
    .values({
      kind: e.kind,
      projectId: e.projectId ?? null,
      milestoneId: e.milestoneId ?? null,
      paymentId: e.paymentId ?? null,
      payoutId: e.payoutId ?? null,
      description: e.description ?? null,
      idempotencyKey: e.idempotencyKey,
    })
    .onConflictDoNothing({ target: ledgerEntries.idempotencyKey })
    .returning({ id: ledgerEntries.id });
  if (!entry) return { posted: false, entryId: null };

  for (const l of e.lines) {
    const id = await accountId(ex, l.account, l.ownerKey, l.currency);
    await ex.insert(ledgerLines).values({ entryId: entry.id, accountId: id, direction: l.direction, amountMinor: l.amountMinor, currency: l.currency });
  }
  return { posted: true, entryId: entry.id };
}

/** credits minus debits, in minor units. */
export async function accountBalance(ex: Executor, kind: AccountKind, ownerKey: string, currency: string): Promise<number> {
  const [r] = await ex
    .select({
      v: sql<string>`coalesce(sum(case when ${ledgerLines.direction} = 'credit' then ${ledgerLines.amountMinor} else -${ledgerLines.amountMinor} end), 0)::text`,
    })
    .from(ledgerLines)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerLines.accountId))
    .where(and(eq(ledgerAccounts.kind, kind), eq(ledgerAccounts.ownerKey, ownerKey), eq(ledgerAccounts.currency, currency)));
  return Number(r?.v ?? 0);
}
