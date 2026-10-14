import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { formatMoney, toMinor } from "../lib/money";
import { useToast } from "../lib/toast";
import type { ChangeRow, Task } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { Button, EmptyState, Note, Pill, Skeleton } from "./ui";

const EFFECTS = [
  { v: "no_cost", label: "No change in price" },
  { v: "increase", label: "Costs more" },
  { v: "reduction", label: "Costs less" },
  { v: "credit", label: "Credit to the customer" },
  { v: "partial_cancellation", label: "Part of the work is cancelled" },
];
const CLOSED = ["completed", "cancelled"];

/** PRD §58-60: nothing in the agreement changes silently. One side proposes; the other side accepts or rejects. */
export function ChangesPanel({ projectId, currency, tasks, onApplied }: { projectId: string; currency: string; tasks: Task[]; onApplied: () => void }) {
  const toast = useToast();
  const list = useLoad(() => api<{ changes: ChangeRow[] }>("GET", `/projects/${projectId}/changes`), [projectId]);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [effect, setEffect] = useState("no_cost");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changes = list.data?.changes ?? [];
  const eligible = tasks.filter((t) => !CLOSED.includes(t.status));
  const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title ?? "A task";

  async function propose(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("Say what is changing");
    if (picked.length === 0) return setError("Choose the task this change affects");
    let cost = 0;
    if (effect !== "no_cost") {
      const m = toMinor(amount, currency);
      if (m === null || m === 0) return setError("Enter the amount of the change");
      cost = effect === "increase" ? m : -m;
    }
    const d = days.trim() === "" ? 0 : Number(days);
    if (!Number.isInteger(d)) return setError("Days must be a whole number (use a minus for earlier)");
    setBusy("propose");
    try {
      await api("POST", `/projects/${projectId}/changes`, {
        title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}),
        financialEffect: effect, costDeltaMinor: cost, scheduleDeltaDays: d, taskIds: picked,
      });
      toast.success("Change proposed. The other side has been told");
      setOpen(false); setTitle(""); setDescription(""); setEffect("no_cost"); setAmount(""); setDays(""); setPicked([]);
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not propose the change");
    } finally {
      setBusy(null);
    }
  }

  async function act(c: ChangeRow, what: "accept" | "reject" | "withdraw") {
    setBusy(`${what}:${c.id}`);
    try {
      await api("POST", `/changes/${c.id}/${what}`, {});
      toast.success(what === "accept" ? "Change accepted: the agreement now has a new baseline" : what === "reject" ? "Change rejected" : "Change withdrawn");
      list.reload();
      if (what === "accept") onApplied();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work");
      list.reload();
    } finally {
      setBusy(null);
    }
  }

  const field = "w-full rounded-xl border border-line bg-surface px-3 py-2 text-base focus:border-brand";
  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Changes</h2>
        {eligible.length > 0 && <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className="rounded-xl border border-line px-3 py-1.5 text-sm font-semibold hover:bg-brand/5">{open ? "Close" : "Propose a change"}</button>}
      </div>

      {open && (
        <form onSubmit={propose} className="mt-3 space-y-3 rounded-2xl border border-line bg-surface p-4">
          <label className="block text-sm"><span className="mb-1 block font-medium">What is changing?</span>
            <input className={field} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Add two extra sockets" /></label>
          <label className="block text-sm"><span className="mb-1 block font-medium">Details (optional)</span>
            <textarea className={field} rows={2} maxLength={3000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          <fieldset className="text-sm"><legend className="mb-1 font-medium">Which task is affected?</legend>
            <div className="space-y-1">{eligible.map((t) => (
              <label key={t.id} className="flex items-center gap-2"><input type="checkbox" checked={picked.includes(t.id)}
                onChange={() => setPicked(picked.includes(t.id) ? picked.filter((x) => x !== t.id) : [...picked, t.id])} /> {t.title}</label>
            ))}</div></fieldset>
          <label className="block text-sm"><span className="mb-1 block font-medium">Effect on price</span>
            <select className={field} value={effect} onChange={(e) => setEffect(e.target.value)}>{EFFECTS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</select></label>
          {effect !== "no_cost" && <label className="block text-sm"><span className="mb-1 block font-medium">Amount ({currency})</span>
            <input className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></label>}
          <label className="block text-sm"><span className="mb-1 block font-medium">Days added (use a minus for fewer)</span>
            <input className={field} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} placeholder="0" /></label>
          {error && <Note>{error}</Note>}
          <Button type="submit" variant="gold" busy={busy === "propose"}>Send proposal</Button>
        </form>
      )}

      {list.loading && !list.data ? <Skeleton className="mt-3 h-16" /> : list.error ? <div className="mt-3"><Note>{list.error}</Note></div> : changes.length === 0 ? (
        <div className="mt-3"><EmptyState title="No changes" hint="If scope, price or timing needs to change, propose it here so both sides agree in writing." /></div>
      ) : (
        <ul className="mt-3 space-y-3">
          {changes.map((c) => (
            <li key={c.id} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><p className="font-semibold">{c.title}</p><p className="text-xs text-ink/60">Proposed by {c.proposerName}</p></div>
                <Pill value={c.status} />
              </div>
              {c.description && <p className="mt-2 text-sm text-ink/70">{c.description}</p>}
              <p className="mt-2 text-sm">
                {c.costDeltaMinor === 0 ? "No price change" : `${c.costDeltaMinor > 0 ? "+" : "-"}${formatMoney(Math.abs(c.costDeltaMinor), c.currency)}`}
                {c.scheduleDeltaDays !== 0 && ` · ${c.scheduleDeltaDays > 0 ? "+" : ""}${c.scheduleDeltaDays} day${Math.abs(c.scheduleDeltaDays) === 1 ? "" : "s"}`}
              </p>
              <p className="mt-1 text-xs text-ink/60">Affects: {c.taskIds.map(titleOf).join(", ")}</p>
              {c.resultingBaselineVersion && <p className="mt-1 text-xs text-ink/60">Now part of the agreement (version {c.resultingBaselineVersion})</p>}
              {(c.youCanRespond || c.youCanWithdraw) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {c.youCanRespond && <button type="button" disabled={busy !== null} onClick={() => void act(c, "accept")} className="rounded-xl bg-gold px-4 py-2 text-sm font-semibold text-ink disabled:opacity-60">Accept</button>}
                  {c.youCanRespond && <button type="button" disabled={busy !== null} onClick={() => void act(c, "reject")} className="rounded-xl border border-line px-4 py-2 text-sm font-semibold disabled:opacity-60">Reject</button>}
                  {c.youCanWithdraw && <button type="button" disabled={busy !== null} onClick={() => void act(c, "withdraw")} className="rounded-xl border border-line px-4 py-2 text-sm font-semibold disabled:opacity-60">Withdraw</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
