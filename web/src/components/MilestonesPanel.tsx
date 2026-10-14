import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { MILESTONE_LABEL, label } from "../lib/labels";
import { formatMoney, toMinor } from "../lib/money";
import { useToast } from "../lib/toast";
import type { Award, Milestone, PaymentView } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { Tape } from "./Tape";
import { Button, EmptyState, Note, Pill, Skeleton } from "./ui";

// PRD §48, §57: a stage is funded, the provider delivers, the approver accepts, then the money is released.
// Approval is not payment: release is its own step. Who sees what follows the API: providers see only their own stages.
const HELD = ["secured", "partially_released"];
const COUNTED = ["secured", "partially_released", "released"];

type Props = { projectId: string; currency: string; isManager: boolean; onChanged: () => void };

export function MilestonesPanel({ projectId, currency, isManager, onChanged }: Props) {
  const { user } = useAuth();
  const toast = useToast();
  const list = useLoad(() => api<{ milestones: Milestone[] }>("GET", `/projects/${projectId}/milestones`), [projectId]);
  const pays = useLoad(
    () => (isManager ? api<{ payments: PaymentView[] }>("GET", `/projects/${projectId}/payments`) : Promise.resolve({ payments: [] as PaymentView[] })),
    [projectId, isManager],
  );
  const awards = useLoad(
    () => (isManager ? api<{ awards: Award[] }>("GET", `/projects/${projectId}/awards`) : Promise.resolve({ awards: [] as Award[] })),
    [projectId, isManager],
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [assignmentId, setAssignmentId] = useState("");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState("");
  const [criteria, setCriteria] = useState("");
  const [changesFor, setChangesFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const ms = list.data?.milestones ?? [];
  const allPays = pays.data?.payments ?? [];
  const awardList = awards.data?.awards ?? [];
  const live = ms.filter((m) => m.status !== "cancelled");
  const planned = live.reduce((s, m) => s + m.amountMinor, 0);
  const funded = allPays.filter((p) => COUNTED.includes(p.state)).reduce((s, p) => s + p.amountMinor, 0);
  const released = allPays.reduce((s, p) => s + p.releasedMinor, 0);
  const chosen = assignmentId || awardList[0]?.assignmentId || "";
  const chosenAward = awardList.find((a) => a.assignmentId === chosen);

  const paymentFor = (m: Milestone) => allPays.find((p) => p.milestoneId === m.id && p.state !== "failed");

  function refresh() {
    list.reload();
    pays.reload();
    awards.reload();
    onChanged();
  }

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setError(null);
    try {
      const msg = await fn();
      if (msg) toast.success(msg);
      refresh();
    } catch (e) {
      const m = e instanceof Error ? e.message : "Something went wrong";
      setError(m);
      toast.error(m);
    } finally {
      setBusy(null);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const minor = toMinor(amount, currency);
    if (!minor || minor <= 0) { setError("Enter an amount greater than zero."); return; }
    if (!chosen) { setError("Award a quote to a provider first."); return; }
    await run("create", async () => {
      await api("POST", `/projects/${projectId}/milestones`, {
        title: title.trim(),
        amountMinor: minor,
        currency,
        assignmentId: chosen,
        ...(due ? { dueAt: new Date(`${due}T23:59:00`).toISOString() } : {}),
        ...(criteria.trim() ? { acceptanceCriteria: criteria.trim() } : {}),
      });
      setTitle(""); setAmount(""); setDue(""); setCriteria(""); setFormOpen(false);
      return "Stage added";
    });
  }

  const fund = (m: Milestone) => run(`fund-${m.id}`, async () => {
    const r = await api<{ payment: { id: string; providerReference: string | null }; checkoutUrl: string }>("POST", `/milestones/${m.id}/payments`, {});
    // The gateway sends the customer back with ?reference=...; this is how the return page finds the payment.
    if (r.payment.providerReference) {
      localStorage.setItem(`lp_pay_${r.payment.providerReference}`, JSON.stringify({ paymentId: r.payment.id, projectId }));
    }
    window.location.assign(r.checkoutUrl);
  });

  const check = (p: PaymentView) => run(`check-${p.id}`, async () => {
    const r = await api<{ outcome: string; payment: { state: string } }>("POST", `/payments/${p.id}/verify`, {});
    if (r.outcome === "secured" || COUNTED.includes(r.payment.state)) return "Payment received";
    if (r.outcome === "failed" || r.payment.state === "failed") return "The payment did not go through. You can start it again.";
    return "Still waiting for the payment to arrive";
  });

  const submit = (m: Milestone) => run(`submit-${m.id}`, async () => { await api("POST", `/milestones/${m.id}/submit`, {}); return "Submitted for approval"; });
  const approve = (m: Milestone) => run(`approve-${m.id}`, async () => { await api("POST", `/milestones/${m.id}/approve`, {}); return "Stage approved"; });
  const release = (m: Milestone) => run(`release-${m.id}`, async () => { await api("POST", `/milestones/${m.id}/release`, {}); return "Payment released to the provider"; });
  const askChanges = (m: Milestone) => run(`changes-${m.id}`, async () => {
    await api("POST", `/milestones/${m.id}/request-changes`, { reason: reason.trim() });
    setChangesFor(null); setReason("");
    return "Sent back to the provider";
  });

  function hint(m: Milestone, p: PaymentView | undefined, isApprover: boolean): string {
    if (isManager) {
      switch (m.status) {
        case "pending": return p ? "Payment started. If you have paid, check the payment." : "Fund this stage before work starts. It is released to the provider when you approve the work.";
        case "funded": return "Funded. Waiting for the provider to deliver the work.";
        case "in_progress": return "Work is in progress.";
        case "submitted": return isApprover ? "The provider says this stage is done. Check it, then approve or ask for changes." : "Waiting for the approver to review.";
        case "approved": return p && HELD.includes(p.state) ? "Approved. Release the payment to the provider." : "Approved, but there is no funded payment waiting to be released.";
        case "released": return "Released to the provider.";
        default: return "";
      }
    }
    switch (m.status) {
      case "pending": return "Not funded yet. Start when the customer has funded this stage.";
      case "funded": case "in_progress": return "Funded. Submit when the work is done.";
      case "submitted": return "Waiting for approval.";
      case "approved": return "Approved. Payment is being released.";
      case "released": return "Paid into your earnings.";
      default: return "";
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">Stages and payment</h2>
        {isManager && awardList.length > 0 && <Button variant="quiet" onClick={() => { setFormOpen((o) => !o); setError(null); }}>{formOpen ? "Close" : "Add a stage"}</Button>}
      </div>

      {error && <Note>{error}</Note>}
      {(list.error || pays.error || awards.error) && (
        <Note>Could not load part of this panel: {list.error ?? pays.error ?? awards.error}</Note>
      )}

      {isManager && live.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface p-4">
          <Tape value={planned > 0 ? released / planned : 0} compact label="Share of the price released" />
          <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <div><dt className="text-ink/60">Planned</dt><dd className="font-semibold">{formatMoney(planned, currency)}</dd></div>
            <div><dt className="text-ink/60">Funded</dt><dd className="font-semibold">{formatMoney(funded, currency)}</dd></div>
            <div><dt className="text-ink/60">Released</dt><dd className="font-semibold">{formatMoney(released, currency)}</dd></div>
          </dl>
        </div>
      )}

      {isManager && formOpen && (
        <form onSubmit={create} className="rise space-y-3 rounded-2xl border border-gold/60 bg-gold/10 p-4">
          <label className="block text-sm font-medium">Provider and task
            <select value={chosen} onChange={(e) => setAssignmentId(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base">
              {awardList.map((a) => <option key={a.assignmentId} value={a.assignmentId}>{a.providerName}: {a.task.title}</option>)}
            </select>
          </label>
          {chosenAward && <p className="text-sm text-ink/70">Agreed price {formatMoney(chosenAward.agreedMinor, chosenAward.currency)}. Left to split into stages: {formatMoney(chosenAward.remainingMinor, chosenAward.currency)}.</p>}
          <label className="block text-sm font-medium">What is this stage?
            <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="For example: Materials and first fix" className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base" />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium">Amount ({currency})
              <input value={amount} onChange={(e) => setAmount(e.target.value)} required inputMode="decimal" placeholder="0.00" className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base" />
            </label>
            <label className="block text-sm font-medium">Due date (optional)
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base" />
            </label>
          </div>
          <label className="block text-sm font-medium">How will you know it is done? (optional)
            <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={2} maxLength={4000} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base" />
          </label>
          <Button type="submit" variant="gold" busy={busy === "create"} disabled={busy !== null || !title.trim() || !amount.trim()}>Add stage</Button>
        </form>
      )}

      {list.loading && !list.data ? (
        <Skeleton className="h-24" />
      ) : ms.length === 0 ? (
        <EmptyState
          title={isManager ? "No stages yet" : "No stages for you yet"}
          hint={isManager ? (awardList.length > 0 ? "Split the agreed price into stages so each part is paid when it is approved." : "Accept a quote first. Stages belong to an accepted provider.") : "Stages appear here once the customer sets them up."}
        />
      ) : (
        <ol className="space-y-3">
          {ms.map((m) => {
            const p = paymentFor(m);
            const isApprover = m.approverUserId === user?.id;
            const key = (k: string) => busy === `${k}-${m.id}`;
            return (
              <li key={m.id} className={`rise rounded-2xl border bg-surface p-4 ${m.status === "released" ? "border-signal/50" : "border-line"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{m.title}</p>
                    <p className="mt-1 text-sm text-ink/70">
                      {formatMoney(m.amountMinor, m.currency)}
                      {m.dueAt && <> · due {new Date(m.dueAt).toLocaleDateString()}</>}
                    </p>
                  </div>
                  <Pill value={m.status} label={label(MILESTONE_LABEL, m.status)} />
                </div>
                {m.acceptanceCriteria && <p className="mt-2 text-sm text-ink/70">Done means: {m.acceptanceCriteria}</p>}
                <p className="mt-2 text-sm text-ink/60">{hint(m, p, isApprover)}</p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {isManager && m.status === "pending" && !p && <Button variant="gold" busy={key("fund")} disabled={busy !== null} onClick={() => fund(m)}>Fund this stage</Button>}
                  {isManager && m.status === "pending" && p?.state === "pending" && <Button variant="quiet" busy={busy === `check-${p.id}`} disabled={busy !== null} onClick={() => check(p)}>Check payment</Button>}
                  {isManager && m.status === "submitted" && isApprover && (
                    <>
                      <Button busy={key("approve")} disabled={busy !== null} onClick={() => approve(m)}>Approve</Button>
                      <Button variant="quiet" disabled={busy !== null} onClick={() => { setChangesFor(changesFor === m.id ? null : m.id); setReason(""); }}>Ask for changes</Button>
                    </>
                  )}
                  {isManager && m.status === "approved" && p && HELD.includes(p.state) && <Button variant="gold" busy={key("release")} disabled={busy !== null} onClick={() => release(m)}>Release payment</Button>}
                  {!isManager && (m.status === "funded" || m.status === "in_progress") && <Button busy={key("submit")} disabled={busy !== null} onClick={() => submit(m)}>Submit for approval</Button>}
                </div>

                {changesFor === m.id && (
                  <div className="mt-3 space-y-2">
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} placeholder="What needs to change?" className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base" />
                    <Button busy={key("changes")} disabled={busy !== null || !reason.trim()} onClick={() => askChanges(m)}>Send back</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
