import "dotenv/config";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { ledgerEntries, payments } from "../db/schema/index.js";
import { getPaymentProvider } from "../payments/index.js";
import { reconcile } from "../payments/reconcile.js";

// READ-ONLY. Compares the gateway's transactions with our payments over the last N days (default 7).
//   npm run reconcile            npm run reconcile -- 30
// Exit code 1 when anything disagrees, so it can be scheduled later.
async function main() {
  const days = Math.max(1, Math.min(90, Number(process.argv[2] ?? 7) || 7));
  const provider = getPaymentProvider();
  if (!provider.listTransactions) { console.error(`Provider "${provider.code}" cannot list transactions.`); process.exit(2); }

  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  console.log(`Reconciling ${provider.code} for the last ${days} day(s)...`);
  const gateway = await provider.listTransactions({ from, to });

  const rows = await db.select({
    id: payments.id, providerReference: payments.providerReference, state: payments.state, amountMinor: payments.amountMinor, currency: payments.currency,
  }).from(payments).where(and(eq(payments.providerCode, provider.code), gte(payments.createdAt, from)));
  const captured = rows.length === 0 ? [] : await db.select({ paymentId: ledgerEntries.paymentId }).from(ledgerEntries)
    .where(and(eq(ledgerEntries.kind, "payment_captured"), inArray(ledgerEntries.paymentId, rows.map((r) => r.id))));
  const capturedIds = new Set(captured.map((c) => c.paymentId));

  const issues = reconcile(gateway, rows.map((r) => ({ ...r, hasCaptureEntry: capturedIds.has(r.id) })));
  console.log(`Gateway transactions: ${gateway.length}   Our payments: ${rows.length}   Discrepancies: ${issues.length}`);
  for (const d of issues) console.log(`- [${d.kind}] ${d.reference ?? "(no reference)"}: ${d.detail}`);
  if (issues.length === 0) console.log("All consistent.");
  await queryClient.end();
  process.exit(issues.length ? 1 : 0);
}
main().catch(async (e) => { console.error(e instanceof Error ? e.message : e); await queryClient.end(); process.exit(2); });
