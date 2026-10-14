import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ContextChat } from "../components/ContextChat";
import { Card, Row, SimpleForm, Tabs, TrustBadge, dt, useRun } from "../components/kit";
import { Button, Note, Pill, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatMoney } from "../lib/money";
import { useIsAdmin } from "../lib/useIsAdmin";
import { useLoad } from "../lib/useLoad";

// PRD §102-104: both sides respond, facts and claims stay apart, a person decides. The summary only organises the record.

type Dispute = { id: string; projectId: string; scopeType: string; scopeId: string | null; reason: string; description: string | null; status: string; amountMinor: number | null; currency: string | null; openedByUserId: string; againstUserId: string | null; resolutionKind: string | null; resolution: string | null };
type Entry = { id: string; authorUserId: string; kind: string; body: string; createdAt: string };
type Summary = { facts: { ref: string; text: string }[]; claims: { by: string; kind: string; text: string }[]; summary: string; source: "record" | "ai"; note: string; timeline: { eventType: string; at: string }[] };

export default function DisputePage() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const isAdmin = useIsAdmin(user?.id);
  const { busy, run } = useRun();
  const [tab, setTab] = useState<"record" | "chat">("record");
  const d = useLoad(() => api<{ dispute: Dispute; entries: Entry[] }>("GET", `/disputes/${id}`), [id]);
  const sum = useLoad(() => api<{ summary: Summary }>("GET", `/disputes/${id}/summary`), [id]);
  if (d.loading && !d.data) return <Skeleton className="h-48" />;
  if (!d.data) return <Note>{d.error ?? "Not found"}</Note>;
  const { dispute, entries } = d.data;
  const open = !["resolved", "closed"].includes(dispute.status);
  const mine = (e: Entry) => e.authorUserId === user?.id;
  const reload = () => { d.reload(); sum.reload(); };

  return (
    <div className="space-y-5">
      <Link to={`/projects/${dispute.projectId}`} className="text-sm font-semibold text-brand underline">Back to project</Link>
      <header className="rounded-2xl border border-line bg-surface p-5">
        <div className="flex items-start justify-between gap-2"><h1 className="text-2xl font-bold capitalize">{dispute.reason.replaceAll("_", " ")}</h1><Pill value={dispute.status} /></div>
        <p className="mt-1 text-sm text-ink/60">About a {dispute.scopeType.replaceAll("_", " ")}{dispute.amountMinor !== null && dispute.currency ? ` · ${formatMoney(dispute.amountMinor, dispute.currency)} held` : ""}</p>
        {dispute.description && <p className="mt-3 text-sm">{dispute.description}</p>}
        {dispute.resolution && <p className="mt-3 rounded-xl bg-signal/10 p-3 text-sm text-signal">Decision ({dispute.resolutionKind}): {dispute.resolution}</p>}
      </header>
      <Tabs tabs={[{ id: "record", label: "The record" }, { id: "chat", label: "Conversation" }]} value={tab} onChange={setTab} />
      {tab === "chat" && <Card><ContextChat type="dispute" id={id} placeholder="Keep it factual" /></Card>}
      {tab === "record" && (
        <>
          <Card title="What the record shows" hint="Facts from the system, kept apart from what each side says." action={sum.data ? <TrustBadge source={sum.data.summary.source} /> : undefined}>
            {sum.data ? (
              <div className="space-y-3 text-sm">
                <ul className="space-y-1.5">{sum.data.summary.facts.map((f) => <li key={f.ref} className="flex gap-2"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />{f.text}</li>)}</ul>
                <p className="rounded-xl bg-brand/5 p-3">{sum.data.summary.summary}</p>
                <p className="text-xs text-ink/50">{sum.data.summary.note}</p>
              </div>
            ) : <Skeleton className="h-16" />}
          </Card>
          <Card title="What each side says">
            {entries.length === 0 ? <p className="text-sm text-ink/60">Nothing yet.</p> : (
              <ul className="space-y-2">{entries.map((e) => (
                <Row key={e.id} className={mine(e) ? "border-brand/40" : ""}>
                  <div className="flex items-center justify-between gap-2 text-xs text-ink/60"><span className="font-semibold capitalize">{e.kind}{mine(e) ? " (you)" : ""}</span><span>{dt(e.createdAt)}</span></div>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{e.body}</p>
                  {open && e.kind === "proposal" && !mine(e) && <Button className="mt-2" variant="gold" busy={busy === e.id} onClick={() => void run(e.id, () => api("POST", `/disputes/${id}/accept-proposal`, { entryId: e.id }), "Agreed and resolved", reload)}>Accept this proposal</Button>}
                </Row>
              ))}</ul>
            )}
          </Card>
          {open && (
            <Card title="Add to this dispute">
              <SimpleForm submit="Add" fields={[
                { name: "kind", label: "Type", type: "select", options: [{ value: "response", label: "My response" }, { value: "claim", label: "A further claim" }, { value: "proposal", label: "A proposed solution" }, { value: "note", label: "A note" }] },
                { name: "body", label: "Say it plainly", type: "textarea", required: true, maxLength: 4000 },
              ]} onSubmit={async (v) => { await api("POST", `/disputes/${id}/entries`, v); reload(); }} />
              {dispute.openedByUserId === user?.id && <Button className="mt-3" variant="quiet" busy={busy === "w"} onClick={() => { if (window.confirm("Withdraw this dispute?")) void run("w", () => api("POST", `/disputes/${id}/withdraw`, {}), "Withdrawn", reload); }}>Withdraw dispute</Button>}
            </Card>
          )}
          {open && isAdmin && (
            <Card title="Staff decision" hint="A person decides. Money moves through the normal payment and refund steps afterwards.">
              <SimpleForm submit="Resolve" fields={[
                { name: "resolutionKind", label: "Outcome", type: "select", options: [{ value: "release", label: "Release to the provider" }, { value: "refund", label: "Refund the customer" }, { value: "partial", label: "Partial" }, { value: "other", label: "Other" }] },
                { name: "resolution", label: "Reasoning", type: "textarea", required: true, maxLength: 4000 },
              ]} onSubmit={async (v) => { await api("POST", `/disputes/${id}/resolve`, v); reload(); }} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
