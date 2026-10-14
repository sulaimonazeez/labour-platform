import { useState } from "react";
import { Card, Row, SimpleForm, Stat, Tabs, day, useRun } from "../components/kit";
import { Avatar } from "../components/ProviderCard";
import { Button, EmptyState, Note, Pill, Skeleton } from "../components/ui";
import { api, ApiError } from "../lib/api";
import type { AssignmentRow, ProviderProfile, ProviderRow } from "../lib/types";
import { useLoad } from "../lib/useLoad";

// PRD §11-12, §81, §88-94: proof of who you are and what you can do, shown without a hidden score. Providers use this page.
type Ver = { id: string; verificationClass: string; status: string; issuer: string | null; expiresAt: string | null };
type Ins = { id: string; kind: string; insurer: string | null; expiresOn: string; status: string };
type Trust = { verification: { verifiedClasses: { class: string; expiresAt: string | null }[] }; workHistory: { completedJobs: number; notCompleted: number; completionRate: number | null; onTimeRate: number | null; repeatCustomers: number }; reviews: { count: number; workmanship: number | null; punctuality: number | null; communication: number | null; professionalism: number | null; quoteAccuracy: number | null }; howToRead: string };
type Team = { id: string; name: string; myRole: string; leaderId: string; members: { providerId: string; name: string; role: string; revenueShareBps: number }[] };

export default function TrustPage() {
  const me = useLoad(() => api<{ provider: ProviderProfile | null }>("GET", "/providers/me").catch((e) => { if (e instanceof ApiError && e.status === 404) return { provider: null }; throw e; }));
  const [tab, setTab] = useState<"trust" | "verify" | "insurance" | "teams" | "subcontract">("trust");
  if (me.loading && !me.data) return <Skeleton className="h-40" />;
  if (!me.data?.provider) return <Note tone="info">This page is for providers. Create a provider profile from your Profile page first.</Note>;
  const p = me.data.provider;
  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3"><Avatar name={p.displayName} size="h-12 w-12" /><div><h1 className="text-2xl font-bold leading-tight">Trust and credentials</h1><p className="text-sm text-ink/60">{p.displayName}</p></div></header>
      <Tabs tabs={[{ id: "trust", label: "How you look" }, { id: "verify", label: "Verification" }, { id: "insurance", label: "Insurance" }, { id: "teams", label: "Teams" }, { id: "subcontract", label: "Subcontract" }]} value={tab} onChange={setTab} />
      {tab === "trust" && <TrustView id={p.id} />}
      {tab === "verify" && <Verify />}
      {tab === "insurance" && <Insurance />}
      {tab === "teams" && <Teams myId={p.id} />}
      {tab === "subcontract" && <Subcontract />}
    </div>
  );
}

function TrustView({ id }: { id: string }) {
  const t = useLoad(() => api<{ trust: Trust }>("GET", `/providers/${id}/trust`), [id]);
  if (!t.data) return <Skeleton className="h-40" />;
  const x = t.data.trust;
  const pct = (n: number | null) => (n === null ? "None yet" : `${n}%`);
  return (
    <div className="space-y-4">
      <Card title="What customers see" hint={x.howToRead}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Stat label="Jobs completed" value={x.workHistory.completedJobs} /><Stat label="Completion rate" value={pct(x.workHistory.completionRate)} /><Stat label="On time" value={pct(x.workHistory.onTimeRate)} /><Stat label="Repeat customers" value={x.workHistory.repeatCustomers} /></div>
      </Card>
      <Card title={`Reviews (${x.reviews.count})`}>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">{([["Workmanship", x.reviews.workmanship], ["Punctuality", x.reviews.punctuality], ["Communication", x.reviews.communication], ["Professionalism", x.reviews.professionalism], ["Quote accuracy", x.reviews.quoteAccuracy]] as const).map(([k, v]) => <div key={k}><dt className="text-ink/60">{k}</dt><dd className="font-semibold">{v === null ? "None yet" : `${v} / 5`}</dd></div>)}</dl>
      </Card>
      <Card title="Verified credentials">{x.verification.verifiedClasses.length === 0 ? <p className="text-sm text-ink/60">None verified yet. Submit one from the Verification tab.</p> : <ul className="flex flex-wrap gap-2">{x.verification.verifiedClasses.map((v, i) => <li key={i} className="rounded-full bg-signal/15 px-3 py-1 text-sm font-semibold capitalize text-signal">{v.class.replaceAll("_", " ")}{v.expiresAt ? ` · until ${day(v.expiresAt)}` : ""}</li>)}</ul>}</Card>
    </div>
  );
}

function Verify() {
  const mine = useLoad(() => api<{ verifications: Ver[] }>("GET", "/verifications/mine"));
  return (
    <div className="space-y-4">
      <Card title="Submit a credential" hint="A person checks it. Credentials can expire, and expired ones stop counting.">
        <SimpleForm columns={2} submit="Submit" fields={[
          { name: "verificationClass", label: "What it proves", type: "select", options: ["contact", "identity", "address", "business", "skill", "professional_licence", "insurance"].map((v) => ({ value: v, label: v.replaceAll("_", " ") })) },
          { name: "issuer", label: "Issued by", maxLength: 200 }, { name: "issuedAt", label: "Issued on", type: "date" }, { name: "expiresAt", label: "Expires on", type: "date" }, { name: "documentRef", label: "Reference or number", maxLength: 500 },
        ]} onSubmit={async (v) => { await api("POST", "/verifications", v); mine.reload(); }} />
      </Card>
      {(mine.data?.verifications.length ?? 0) === 0 ? <EmptyState title="Nothing submitted" hint="Your submissions and their status appear here." /> : <ul className="space-y-2">{mine.data?.verifications.map((v) => <Row key={v.id} className="flex items-center justify-between gap-2"><span><span className="font-semibold capitalize">{v.verificationClass.replaceAll("_", " ")}</span><span className="block text-xs text-ink/60">{v.issuer ?? "Issuer not stated"}{v.expiresAt ? ` · expires ${day(v.expiresAt)}` : ""}</span></span><Pill value={v.status} /></Row>)}</ul>}
    </div>
  );
}

function Insurance() {
  const list = useLoad(() => api<{ insurance: Ins[] }>("GET", "/providers/me/insurance"));
  return (
    <div className="space-y-4">
      <Card title="Add a policy" hint="Customers see the kind, status and expiry only. Policy numbers stay private.">
        <SimpleForm columns={2} submit="Add policy" fields={[
          { name: "kind", label: "Kind", type: "select", options: ["professional_indemnity", "public_liability", "worker", "vehicle", "project"].map((v) => ({ value: v, label: v.replaceAll("_", " ") })) },
          { name: "insurer", label: "Insurer", maxLength: 200 }, { name: "policyRef", label: "Policy number", maxLength: 200 }, { name: "expiresOn", label: "Expires on", type: "date", required: true },
          { name: "coverMinor", label: "Cover amount (minor units)", type: "number" }, { name: "currency", label: "Currency", maxLength: 3 },
        ]} onSubmit={async (v) => { await api("POST", "/providers/me/insurance", v); list.reload(); }} />
      </Card>
      {(list.data?.insurance.length ?? 0) === 0 ? <EmptyState title="No policies" hint="Add one to qualify for work that requires insurance." /> : <ul className="space-y-2">{list.data?.insurance.map((i) => <Row key={i.id} className="flex items-center justify-between gap-2"><span><span className="font-semibold capitalize">{i.kind.replaceAll("_", " ")}</span><span className="block text-xs text-ink/60">{i.insurer ?? ""} · expires {day(i.expiresOn)}</span></span><Pill value={i.status} /></Row>)}</ul>}
    </div>
  );
}

function ProviderPicker({ onPick, label }: { onPick: (p: ProviderRow) => void; label: string }) {
  const [q, setQ] = useState("");
  const r = useLoad(() => api<{ providers: ProviderRow[] }>("GET", `/providers?q=${encodeURIComponent(q)}`), [q]);
  return (
    <div className="space-y-2">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people by name or headline" className="w-full rounded-xl border border-line bg-surface px-3 py-2.5" />
      <ul className="max-h-56 space-y-1.5 overflow-y-auto">{(r.data?.providers ?? []).map((p) => <li key={p.id}><button type="button" onClick={() => onPick(p)} className="flex w-full items-center gap-3 rounded-xl border border-line p-2 text-left hover:bg-brand/5"><Avatar name={p.displayName} size="h-9 w-9" text="text-xs" /><span className="min-w-0"><span className="block truncate font-medium">{p.displayName}</span><span className="block truncate text-xs text-ink/60">{p.headline ?? ""}</span></span><span className="ml-auto text-xs font-semibold text-brand">{label}</span></button></li>)}</ul>
    </div>
  );
}

function Teams({ myId }: { myId: string }) {
  const teams = useLoad(() => api<{ teams: Team[] }>("GET", "/teams"));
  const { run } = useRun();
  const [adding, setAdding] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Card title="Start a team" hint="A team lets a leader assign work and split revenue. Shares cannot add up to more than 100%.">
        <SimpleForm submit="Create team" fields={[{ name: "name", label: "Team name", required: true, maxLength: 120 }]} onSubmit={async (v) => { await api("POST", "/teams", v); teams.reload(); }} />
      </Card>
      {(teams.data?.teams.length ?? 0) === 0 ? <EmptyState title="No teams" hint="Teams you lead or belong to appear here." /> : teams.data?.teams.map((t) => (
        <Card key={t.id} title={t.name} hint={`You are the ${t.myRole}`}>
          <ul className="space-y-1.5 text-sm">{t.members.map((m) => <li key={m.providerId} className="flex justify-between"><span className="font-medium">{m.name} <span className="text-ink/50">· {m.role}</span></span><span>{(m.revenueShareBps / 100).toFixed(1)}%</span></li>)}</ul>
          {t.leaderId === myId && (adding === t.id ? (
            <div className="mt-3 space-y-2"><ProviderPicker label="Add" onPick={(p) => void run("add", () => api("POST", `/teams/${t.id}/members`, { providerProfileId: p.id, role: "member" }), `${p.displayName} added`, () => { setAdding(null); teams.reload(); })} /><Button variant="quiet" onClick={() => setAdding(null)}>Close</Button></div>
          ) : <Button className="mt-3" variant="quiet" onClick={() => setAdding(t.id)}>Add a member</Button>)}
        </Card>
      ))}
    </div>
  );
}

function Subcontract() {
  const asg = useLoad(() => api<{ assignments: AssignmentRow[] }>("GET", "/assignments"));
  const { run } = useRun();
  const [pick, setPick] = useState<{ assignmentId: string; provider?: ProviderRow } | null>(null);
  const [scope, setScope] = useState("");
  const active = (asg.data?.assignments ?? []).filter((a) => ["accepted", "active"].includes(a.status));
  return (
    <div className="space-y-4">
      <Note tone="info">You cannot hand work to someone silently. The project manager approves a subcontractor before they are added.</Note>
      {active.length === 0 ? <EmptyState title="No active jobs" hint="Accepted jobs you can subcontract appear here." /> : active.map((a) => (
        <Card key={a.id} title={a.task.title} hint={a.project.title}>
          {pick?.assignmentId === a.id ? (
            <div className="space-y-3">
              {pick.provider ? <p className="text-sm">Subcontractor: <span className="font-semibold">{pick.provider.displayName}</span></p> : <ProviderPicker label="Choose" onPick={(p) => setPick({ assignmentId: a.id, provider: p })} />}
              <textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={2} placeholder="What will they do?" className="w-full rounded-xl border border-line bg-surface px-3 py-2.5" />
              <div className="flex gap-2"><Button variant="gold" disabled={!pick.provider || scope.trim().length < 3} onClick={() => void run("sub", () => api("POST", `/assignments/${a.id}/subcontract`, { subcontractorProviderId: pick.provider?.id, scope: scope.trim() }), "Sent to the project manager for approval", () => { setPick(null); setScope(""); })}>Ask for approval</Button><Button variant="quiet" onClick={() => setPick(null)}>Cancel</Button></div>
            </div>
          ) : <Button variant="quiet" onClick={() => setPick({ assignmentId: a.id })}>Subcontract part of this</Button>}
        </Card>
      ))}
    </div>
  );
}
