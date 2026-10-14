import { useState } from "react";
import { Button, EmptyState, Note, Pill, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { formatMoney } from "../lib/money";
import { useToast } from "../lib/toast";
import { useLoad } from "../lib/useLoad";

// Platform staff only (PRD §145). The server answers 404 to anyone else, and this page just shows that.
// Approving moves real money, so it takes two taps and shows exactly who and where.
type AdminPayout = {
  id: string; amountMinor: number; currency: string; state: string; failureReason: string | null; createdAt: string;
  providerName: string | null; accountName: string | null; accountLast4: string | null; bankCode: string | null;
};
type Attention = { events: { id: string; eventType: string; occurredAt: string }[]; stalePayments: unknown[]; openPayouts: unknown[] };

const TABS = ["pending", "processing", "failed", "paid", "cancelled"] as const;
type Tab = (typeof TABS)[number];
const input = "mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base";

export default function Admin() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("pending");
  const attention = useLoad(() => api<Attention>("GET", "/admin/attention"));
  const queue = useLoad(() => api<{ payouts: AdminPayout[] }>("GET", `/admin/payouts?state=${tab}`), [tab]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; kind: "approve" | "reject" } | null>(null);
  const [reason, setReason] = useState("");

  async function run(id: string, fn: () => Promise<string>) {
    setBusy(id);
    setError(null);
    try {
      toast.success(await fn());
    } catch (e) {
      const m = e instanceof Error ? e.message : "Something went wrong";
      setError(m);
      toast.error(m);
    } finally {
      setBusy(null);
      setConfirm(null);
      setReason("");
      queue.reload();
      attention.reload();
    }
  }

  const approve = (p: AdminPayout) => run(p.id, async () => {
    const r = await api<{ outcome: string }>("POST", `/admin/payouts/${p.id}/approve`, {});
    return `Approved. Result: ${r.outcome.replaceAll("_", " ")}`;
  });
  const reject = (p: AdminPayout) => run(p.id, async () => {
    await api("POST", `/admin/payouts/${p.id}/reject`, reason.trim() ? { reason: reason.trim() } : {});
    return "Rejected. The earnings went back to the provider.";
  });
  const check = (p: AdminPayout) => run(p.id, async () => {
    const r = await api<{ outcome: string; gatewayStatus: string | null }>("POST", `/admin/payouts/${p.id}/verify`, {});
    return `Gateway says: ${(r.gatewayStatus ?? r.outcome).replaceAll("_", " ")}`;
  });

  if (queue.error === "Not found" && !queue.data) {
    return <EmptyState title="Nothing here" hint="This page is for platform staff." />;
  }

  const list = queue.data?.payouts ?? [];
  const a = attention.data;

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Admin</h1>
      {error && <Note>{error}</Note>}

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Needs attention</h2>
        {attention.loading && !a ? <Skeleton className="h-20" /> : a && (
          <>
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div className="rounded-2xl border border-line bg-surface p-3"><dt className="text-ink/60">Alerts, 30 days</dt><dd className="mt-1 text-2xl font-bold">{a.events.length}</dd></div>
              <div className="rounded-2xl border border-line bg-surface p-3"><dt className="text-ink/60">Stale payments</dt><dd className="mt-1 text-2xl font-bold">{a.stalePayments.length}</dd></div>
              <div className="rounded-2xl border border-line bg-surface p-3"><dt className="text-ink/60">Open payouts</dt><dd className="mt-1 text-2xl font-bold">{a.openPayouts.length}</dd></div>
            </dl>
            {a.events.length > 0 && (
              <ul className="space-y-1 text-sm text-ink/70">
                {a.events.slice(0, 5).map((e) => <li key={e.id}>{e.eventType.replaceAll(".", " ").replaceAll("_", " ")} · {new Date(e.occurredAt).toLocaleString()}</li>)}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Payouts</h2>
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button key={t} type="button" onClick={() => { setTab(t); setConfirm(null); }} aria-pressed={tab === t}
              className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ${tab === t ? "bg-brand text-onbrand" : "border border-line bg-surface text-ink/70"}`}>{t}</button>
          ))}
        </div>

        {queue.error && queue.error !== "Not found" && <Note>{queue.error}</Note>}
        {queue.loading && !queue.data ? <Skeleton className="h-24" /> : list.length === 0 ? (
          <EmptyState title={`No ${tab} payouts`} hint={tab === "pending" ? "Requests from providers waiting for approval appear here." : "Nothing in this state."} />
        ) : (
          <ul className="space-y-3">
            {list.map((p) => (
              <li key={p.id} className="rise rounded-2xl border border-line bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xl font-bold">{formatMoney(p.amountMinor, p.currency)}</p>
                  <Pill value={p.state} />
                </div>
                <p className="mt-1 text-sm">{p.providerName ?? "Unknown provider"}</p>
                <p className="text-sm text-ink/60">
                  {p.accountName ? `${p.accountName} · bank ${p.bankCode} · ending ${p.accountLast4}` : "No payout account on file"}
                </p>
                <p className="mt-1 text-xs text-ink/50">Requested {new Date(p.createdAt).toLocaleString()}</p>
                {p.state === "failed" && p.failureReason && <p className="mt-1 text-sm text-alarm">{p.failureReason}</p>}

                <div className="mt-3 flex flex-wrap gap-2">
                  {p.state === "pending" && (
                    <>
                      <Button variant="gold" disabled={busy !== null || !p.accountName} onClick={() => setConfirm(confirm?.id === p.id && confirm.kind === "approve" ? null : { id: p.id, kind: "approve" })}>Approve</Button>
                      <Button variant="quiet" disabled={busy !== null} onClick={() => setConfirm(confirm?.id === p.id && confirm.kind === "reject" ? null : { id: p.id, kind: "reject" })}>Reject</Button>
                    </>
                  )}
                  {p.state === "processing" && <Button variant="quiet" busy={busy === p.id} disabled={busy !== null} onClick={() => check(p)}>Check status</Button>}
                </div>

                {confirm?.id === p.id && confirm.kind === "approve" && (
                  <div className="rise mt-3 space-y-2 rounded-xl border border-gold/60 bg-gold/10 p-3">
                    <p className="text-sm font-medium">Send {formatMoney(p.amountMinor, p.currency)} to {p.accountName} ending {p.accountLast4}? This sends real money.</p>
                    <div className="flex gap-2">
                      <Button busy={busy === p.id} disabled={busy !== null} onClick={() => approve(p)}>Yes, send it</Button>
                      <Button variant="quiet" disabled={busy !== null} onClick={() => setConfirm(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
                {confirm?.id === p.id && confirm.kind === "reject" && (
                  <div className="rise mt-3 space-y-2 rounded-xl border border-line p-3">
                    <label className="block text-sm font-medium">Reason (optional)
                      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={input} />
                    </label>
                    <div className="flex gap-2">
                      <Button busy={busy === p.id} disabled={busy !== null} onClick={() => reject(p)}>Reject payout</Button>
                      <Button variant="quiet" disabled={busy !== null} onClick={() => setConfirm(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
