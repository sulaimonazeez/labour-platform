import { useState } from "react";
import { Card, Row, SimpleForm, Stat, Tabs, useRun } from "../components/kit";
import { Button, EmptyState, Note, Pill, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { formatMoney } from "../lib/money";
import { useLoad } from "../lib/useLoad";

// PRD §8, §119-122: training -> assessment -> verification -> listing -> real work -> earnings. Outcomes, not attendance.
// Personal details are for the programme's own admins and auditors. Everything aggregated hides small groups.
type Org = { id: string; name: string; type: string; roles: string[] };
type Programme = { id: string; organisationId: string; name: string; region: string | null };
type Participant = { userId: string; name: string; email: string | null; status: string; hasProviderProfile: boolean };
type Outcomes = { participants: number | null; byStatus: { status: string; count: number | null }[]; completedWork: { currency: string | null; workers: number | null; jobs: number | null; earnedMinor: number | null }[]; minimumGroupSize: number; note: string };
const STATUSES = ["enrolled", "trained", "assessed", "verified", "listed", "working", "graduated", "withdrawn"];

export default function Programmes() {
  const orgs = useLoad(() => api<{ organisations: Org[] }>("GET", "/orgs"));
  const list = useLoad(() => api<{ programmes: Programme[] }>("GET", "/programmes"));
  const [open, setOpen] = useState<string | null>(null);
  const adminOrgs = (orgs.data?.organisations ?? []).filter((o) => o.roles.some((r) => ["owner", "admin"].includes(r)) && ["government", "ngo", "institution"].includes(o.type));
  if (list.loading && !list.data) return <Skeleton className="h-32" />;
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Programmes</h1>
      {adminOrgs.length > 0 ? (
        <Card title="Start a programme" hint="For a government body, NGO or institution organisation you administer.">
          <SimpleForm columns={2} submit="Create" fields={[{ name: "organisationId", label: "Organisation", type: "select", options: adminOrgs.map((o) => ({ value: o.id, label: o.name })) }, { name: "name", label: "Programme name", required: true, maxLength: 200 }, { name: "region", label: "Region", maxLength: 120 }, { name: "startsOn", label: "Starts", type: "date" }, { name: "endsOn", label: "Ends", type: "date" }]} onSubmit={async (v) => { await api("POST", "/programmes", v); list.reload(); }} />
        </Card>
      ) : <Note tone="info">Programmes belong to a government, NGO or institution organisation. Create one on the Organisation page to run a programme.</Note>}
      {(list.data?.programmes.length ?? 0) === 0 ? <EmptyState title="No programmes" hint="Programmes you can see appear here." /> : list.data?.programmes.map((p) => (
        <section key={p.id}>
          <button type="button" onClick={() => setOpen(open === p.id ? null : p.id)} className="flex w-full items-center justify-between rounded-2xl border border-line bg-surface p-4 text-left"><span><span className="font-semibold">{p.name}</span><span className="block text-xs text-ink/60">{p.region ?? "No region set"}</span></span><span className="text-sm font-semibold text-brand">{open === p.id ? "Close" : "Open"}</span></button>
          {open === p.id && <div className="mt-3"><Detail id={p.id} /></div>}
        </section>
      ))}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const [tab, setTab] = useState<"outcomes" | "people">("outcomes");
  const out = useLoad(() => api<{ outcomes: Outcomes }>("GET", `/programmes/${id}/outcomes`), [id]);
  const people = useLoad(() => api<{ participants: Participant[] }>("GET", `/programmes/${id}/participants`).catch(() => ({ participants: [] as Participant[] })), [id]);
  const { busy, run } = useRun();
  const o = out.data?.outcomes;
  return (
    <div className="space-y-4">
      <Tabs tabs={[{ id: "outcomes", label: "Outcomes" }, { id: "people", label: "People" }]} value={tab} onChange={setTab} />
      {tab === "outcomes" && (o ? (
        <>
          <Card title="Where people are" hint={o.note}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Stat label="Participants" value={o.participants ?? "hidden"} />{o.byStatus.map((s) => <Stat key={s.status} label={s.status} value={s.count ?? "hidden"} />)}</div>
          </Card>
          <Card title="Work obtained and earnings" hint="From completed jobs on the platform. Per currency.">
            {o.completedWork.length === 0 ? <p className="text-sm text-ink/60">No completed work yet.</p> : <div className="grid gap-2 sm:grid-cols-2">{o.completedWork.map((w, i) => <Stat key={i} label={`${w.workers ?? "hidden"} workers · ${w.jobs ?? "hidden"} jobs`} value={w.earnedMinor === null || !w.currency ? "hidden" : formatMoney(w.earnedMinor, w.currency)} />)}</div>}
          </Card>
        </>
      ) : <Skeleton className="h-24" />)}
      {tab === "people" && (
        <>
          <Card title="Enrol someone" hint="They need an account already."><SimpleForm submit="Enrol" fields={[{ name: "email", label: "Email", type: "email", required: true }]} onSubmit={async (v) => { await api("POST", `/programmes/${id}/participants`, v); people.reload(); out.reload(); }} /></Card>
          {(people.data?.participants.length ?? 0) === 0 ? <EmptyState title="No participants visible" hint="Only the programme's admins and auditors can see names." /> : <ul className="space-y-2">{people.data?.participants.map((p) => (
            <Row key={p.userId}><div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{p.name}</p><p className="text-xs text-ink/60">{p.email}{p.hasProviderProfile ? " · has a provider profile" : ""}</p></div><Pill value={p.status} /></div>
              <select aria-label="Move to" value={p.status} disabled={busy === p.userId} onChange={(e) => void run(p.userId, () => api("POST", `/programmes/${id}/participants/${p.userId}/status`, { status: e.target.value }), "Updated", () => { people.reload(); out.reload(); })} className="mt-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm">{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Row>
          ))}</ul>}
        </>
      )}
    </div>
  );
}
