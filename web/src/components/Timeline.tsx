import { useState } from "react";
import { api } from "../lib/api";
import { formatMoney } from "../lib/money";
import { useLoad } from "../lib/useLoad";
import { Note, Skeleton } from "./ui";

type EventRow = {
  id: string; eventType: string; payload: Record<string, unknown>; occurredAt: string; actorName: string | null; actorType: string;
};

const s = (v: unknown) => (typeof v === "string" ? v : undefined);

// Wording per machine event type, so it can be translated later (PRD §113). Unknown types fall back to a readable form.
// `task.transitioned` repeats what task.started/submitted/approved/completed already say, so it is left out.
const LABEL: Record<string, (p: Record<string, unknown>) => string> = {
  "project.created": () => "Project created",
  "task.provider_invited": () => "A provider was invited to quote",
  "quote.submitted": () => "A quote was sent",
  "quote.accepted": () => "A quote was accepted",
  "assignment.accepted": () => "The provider accepted the job",
  "assignment.rejected": () => "The provider declined the job",
  "task.started": () => "Work started",
  "task.submitted": (p) => `Work submitted for approval${s(p.note) ? `: ${s(p.note)}` : ""}`,
  "task.changes_requested": (p) => `Changes requested${s(p.reason) ? `: ${s(p.reason)}` : ""}`,
  "task.approved": () => "Work approved",
  "task.completed": () => "Task completed",
  "evidence.added": (p) => `${(s(p.kind) ?? "evidence").replaceAll("_", " ")} added`,
  "change.proposed": (p) => `Change proposed${s(p.title) ? `: ${s(p.title)}` : ""}`,
  "change.accepted": () => "Change accepted",
  "change.rejected": (p) => `Change rejected${s(p.reason) ? `: ${s(p.reason)}` : ""}`,
  "change.withdrawn": () => "Change withdrawn",
  "change.applied": (p) =>
    `Agreement updated to version ${String(p.resultingBaselineVersion ?? "?")}${typeof p.costDeltaMinor === "number" && p.costDeltaMinor !== 0 && s(p.currency) ? ` (${p.costDeltaMinor > 0 ? "+" : "-"}${formatMoney(Math.abs(p.costDeltaMinor), s(p.currency)!)})` : ""}`,
  "review.created": () => "A review was left",
  "request.converted": () => "The request became a project",
  "task.created": (p) => `Task added${s(p.title) ? `: ${s(p.title)}` : ""}`,
  "assignment.offered": () => "The job was offered to a provider",
  "quote.revision_requested": () => "A quote revision was requested",
  "quote.revised": () => "A quote was revised",
  "quote.rejected": () => "A quote was declined",
  "quote.withdrawn": () => "A quote was withdrawn",
  "milestone.created": () => "A milestone was set up",
  "milestone.submitted": () => "A milestone was submitted",
  "milestone.approved": () => "A milestone was approved",
  "milestone.changes_requested": () => "Changes were requested on a milestone",
  "milestone.released": () => "Milestone payment released",
  "payment.initiated": () => "A payment was started",
  "payment.secured": () => "A payment is secured",
  "payment.failed": () => "A payment failed",
  "payment.expired": () => "A payment expired",
  "payout.paid": () => "A payout was paid",
  "payout.failed": () => "A payout failed",
};
// Technical events stay in the audit trail but are not shown here. task.transitioned repeats task.started/submitted/approved/completed.
const HIDDEN = new Set(["task.transitioned", "gateway.event_received", "quote.created", "quote.draft_edited", "task.dependency_added", "payment.amount_mismatch", "payment.late_success", "payout.requested", "payout.processing", "payout.cancelled", "payout.reversal_after_paid"]);
const humanise = (t: string) => t.replaceAll(".", " ").replaceAll("_", " ");

/** The project's chronological record (PRD §68). Newest first, 20 at a time. */
export function Timeline({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Timeline</h2>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-xl border border-line px-3 py-1.5 text-sm font-semibold hover:bg-brand/5">{open ? "Hide" : "Show"}</button>
      </div>
      {open && <TimelineList projectId={projectId} />}
    </section>
  );
}

function TimelineList({ projectId }: { projectId: string }) {
  const first = useLoad(() => api<{ events: EventRow[]; nextBefore: string | null }>("GET", `/projects/${projectId}/activity?limit=20`), [projectId]);
  const [more, setMore] = useState<EventRow[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cursor = next === undefined ? first.data?.nextBefore ?? null : next;
  const events = [...(first.data?.events ?? []), ...more].filter((e) => !HIDDEN.has(e.eventType));

  async function loadMore() {
    if (!cursor) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ events: EventRow[]; nextBefore: string | null }>("GET", `/projects/${projectId}/activity?limit=20&before=${encodeURIComponent(cursor)}`);
      setMore((m) => [...m, ...r.events]);
      setNext(r.nextBefore);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more");
    } finally { setBusy(false); }
  }

  if (first.loading && !first.data) return <Skeleton className="mt-3 h-20" />;
  if (first.error) return <div className="mt-3"><Note>{first.error}</Note></div>;
  if (events.length === 0) return <p className="mt-3 text-sm text-ink/60">Nothing has happened yet.</p>;
  return (
    <div className="mt-3">
      <ol className="space-y-3 border-l-2 border-line pl-4">
        {events.map((e) => (
          <li key={e.id} className="relative">
            <span aria-hidden className="absolute -left-[22px] top-1.5 h-2.5 w-2.5 rounded-full bg-brand" />
            <p className="text-sm">{(LABEL[e.eventType] ?? (() => humanise(e.eventType)))(e.payload)}</p>
            <p className="text-xs text-ink/60">{e.actorName ?? (e.actorType === "system" ? "System" : "Someone")} · {new Date(e.occurredAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>
          </li>
        ))}
      </ol>
      {error && <div className="mt-2"><Note>{error}</Note></div>}
      {cursor && <button type="button" disabled={busy} onClick={() => void loadMore()} className="mt-3 rounded-xl border border-line px-3 py-1.5 text-sm font-semibold disabled:opacity-60">{busy ? "Loading..." : "Show older"}</button>}
    </div>
  );
}
