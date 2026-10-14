import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, Row, SimpleForm, Stat, Tabs, dt, useRun } from "../components/kit";
import { Button, EmptyState, Note, Pill, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { useLoad } from "../lib/useLoad";

// PRD §127, §145, §150-151: markets, flags, queues and operational signals in one place. The server enforces who is staff.
type Tab = "overview" | "queues" | "flags" | "markets" | "signals" | "policy";

export default function AdminConsole() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Admin console</h1>
      <Tabs tabs={[{ id: "overview", label: "Overview" }, { id: "queues", label: "Queues" }, { id: "flags", label: "Flags" }, { id: "markets", label: "Markets" }, { id: "signals", label: "Signals" }, { id: "policy", label: "Policy" }]} value={tab} onChange={setTab} />
      {tab === "overview" && <Overview />}
      {tab === "queues" && <Queues />}
      {tab === "flags" && <Flags />}
      {tab === "markets" && <Markets />}
      {tab === "signals" && <Signals />}
      {tab === "policy" && <Policy />}
    </div>
  );
}

function Overview() {
  const o = useLoad(() => api<{ overview: { users: number; providers: number; projectsByStatus: { s: string; n: number }[]; openDisputes: number; openSafetyIncidents: number; pendingVerifications: number; openModerationReports: number; openPrivacyRequests: number } }>("GET", "/admin/overview"));
  if (!o.data) return o.error ? <Note>{o.error}</Note> : <Skeleton className="h-32" />;
  const x = o.data.overview;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Stat label="People" value={x.users} /><Stat label="Providers" value={x.providers} /><Stat label="Open disputes" value={x.openDisputes} /><Stat label="Safety incidents" value={x.openSafetyIncidents} /><Stat label="To verify" value={x.pendingVerifications} /><Stat label="Reports" value={x.openModerationReports} /><Stat label="Privacy requests" value={x.openPrivacyRequests} /></div>
      <Card title="Projects by status"><ul className="flex flex-wrap gap-2">{x.projectsByStatus.map((p) => <li key={p.s} className="rounded-full bg-brand/10 px-3 py-1 text-sm font-semibold">{p.s.replaceAll("_", " ")}: {p.n}</li>)}</ul></Card>
    </div>
  );
}

function Queues() {
  const { busy, run } = useRun();
  const ver = useLoad(() => api<{ verifications: { id: string; userName: string; verificationClass: string; issuer: string | null; documentRef: string | null; expiresAt: string | null }[] }>("GET", "/verifications?status=pending"));
  const dis = useLoad(() => api<{ disputes: { id: string; reason: string; status: string; createdAt: string }[] }>("GET", "/disputes?status=awaiting_response"));
  const inc = useLoad(() => api<{ incidents: { id: string; category: string; severity: string; status: string; description: string }[] }>("GET", "/safety-incidents?status=reported"));
  const mod = useLoad(() => api<{ reports: { id: string; targetType: string; reason: string; detail: string | null; createdAt: string }[] }>("GET", "/moderation/reports"));
  const pri = useLoad(() => api<{ requests: { id: string; kind: string; status: string; note: string | null; createdAt: string }[] }>("GET", "/admin/privacy-requests"));
  return (
    <div className="space-y-4">
      <Card title={`Verifications (${ver.data?.verifications.length ?? 0})`}>{(ver.data?.verifications.length ?? 0) === 0 ? <p className="text-sm text-ink/60">Nothing waiting.</p> : <ul className="space-y-2">{ver.data?.verifications.map((v) => <Row key={v.id}><p className="font-semibold">{v.userName} · {v.verificationClass.replaceAll("_", " ")}</p><p className="text-xs text-ink/60">{v.issuer ?? "no issuer"} · ref {v.documentRef ?? "none"}{v.expiresAt ? ` · expires ${v.expiresAt}` : ""}</p><div className="mt-2 flex gap-2">{(["verified", "rejected"] as const).map((d) => <Button key={d} variant={d === "verified" ? "gold" : "quiet"} busy={busy === v.id + d} onClick={() => void run(v.id + d, () => api("POST", `/verifications/${v.id}/decide`, { decision: d }), "Done", ver.reload)}>{d === "verified" ? "Verify" : "Reject"}</Button>)}</div></Row>)}</ul>}</Card>
      <Card title={`Disputes awaiting a response (${dis.data?.disputes.length ?? 0})`}>{(dis.data?.disputes.length ?? 0) === 0 ? <p className="text-sm text-ink/60">None.</p> : <ul className="space-y-1.5 text-sm">{dis.data?.disputes.map((d) => <li key={d.id}><Link className="font-semibold text-brand underline" to={`/disputes/${d.id}`}>{d.reason.replaceAll("_", " ")}</Link> <span className="text-ink/50">{dt(d.createdAt)}</span></li>)}</ul>}</Card>
      <Card title={`Safety incidents (${inc.data?.incidents.length ?? 0})`}>{(inc.data?.incidents.length ?? 0) === 0 ? <p className="text-sm text-ink/60">None open.</p> : <ul className="space-y-2">{inc.data?.incidents.map((i) => <Row key={i.id}><p className="font-semibold capitalize">{i.category.replaceAll("_", " ")} · {i.severity}</p><p className="text-sm">{i.description}</p><div className="mt-2 flex gap-2">{(["under_review", "closed"] as const).map((s) => <Button key={s} variant="quiet" busy={busy === i.id + s} onClick={() => void run(i.id + s, () => api("POST", `/safety-incidents/${i.id}/status`, { status: s }), "Updated", inc.reload)}>{s === "closed" ? "Close" : "Start review"}</Button>)}</div></Row>)}</ul>}</Card>
      <Card title={`Reports (${mod.data?.reports.length ?? 0})`}>{(mod.data?.reports.length ?? 0) === 0 ? <p className="text-sm text-ink/60">None open.</p> : <ul className="space-y-2">{mod.data?.reports.map((r) => <Row key={r.id}><p className="font-semibold">{r.reason.replaceAll("_", " ")} · {r.targetType}</p><p className="text-xs text-ink/60">{r.detail ?? ""} {dt(r.createdAt)}</p><div className="mt-2 flex gap-2">{(["actioned", "dismissed"] as const).map((s) => <Button key={s} variant="quiet" busy={busy === r.id + s} onClick={() => void run(r.id + s, () => api("POST", `/moderation/reports/${r.id}/resolve`, { status: s }), "Done", mod.reload)}>{s}</Button>)}</div></Row>)}</ul>}</Card>
      <Card title="Privacy requests">{(pri.data?.requests.length ?? 0) === 0 ? <p className="text-sm text-ink/60">None.</p> : <ul className="space-y-2">{pri.data?.requests.map((r) => <Row key={r.id}><div className="flex justify-between gap-2"><span className="font-semibold capitalize">{r.kind}</span><Pill value={r.status} /></div>{r.status === "received" && <div className="mt-2 flex gap-2">{(["in_progress", "completed", "refused"] as const).map((s) => <Button key={s} variant="quiet" busy={busy === r.id + s} onClick={() => void run(r.id + s, () => api("POST", `/admin/privacy-requests/${r.id}/status`, { status: s }), "Updated", pri.reload)}>{s.replaceAll("_", " ")}</Button>)}</div>}</Row>)}</ul>}</Card>
    </div>
  );
}

function Flags() {
  const f = useLoad(() => api<{ flags: { key: string; description: string | null; enabled: boolean; scope: Record<string, unknown> }[] }>("GET", "/admin/flags"));
  const { busy, run } = useRun();
  return (
    <div className="space-y-4">
      <Card title="Switch a capability on or off" hint="A flag that does not exist is ON. Add one to restrict something. Scope by market code, rollout percent, or both.">
        <SimpleForm columns={2} submit="Save flag" fields={[{ name: "key", label: "Key", required: true, placeholder: "ai.scope_draft" }, { name: "enabled", label: "Enabled", type: "checkbox", defaultValue: true }, { name: "markets", label: "Only these markets (comma separated codes)", placeholder: "NG,GH" }, { name: "rolloutPercent", label: "Rollout percent", type: "number" }, { name: "description", label: "Description", maxLength: 300 }]}
          onSubmit={async (v) => { const scope: Record<string, unknown> = {}; if (v.markets) scope.markets = String(v.markets).split(",").map((x) => x.trim()).filter(Boolean); if (v.rolloutPercent !== undefined) scope.rolloutPercent = v.rolloutPercent; await api("PUT", `/admin/flags/${v.key}`, { enabled: Boolean(v.enabled), description: v.description, scope }); f.reload(); }} />
      </Card>
      <ul className="space-y-2">{(f.data?.flags ?? []).map((x) => <Row key={x.key} className="flex items-center justify-between gap-2"><span><span className="font-mono text-sm font-semibold">{x.key}</span><span className="block text-xs text-ink/60">{x.description ?? ""} {Object.keys(x.scope).length ? JSON.stringify(x.scope) : ""}</span></span><Button variant="quiet" busy={busy === x.key} onClick={() => void run(x.key, () => api("PUT", `/admin/flags/${x.key}`, { enabled: !x.enabled, description: x.description ?? undefined, scope: x.scope }), x.enabled ? "Switched off" : "Switched on", f.reload)}>{x.enabled ? "Turn off" : "Turn on"}</Button></Row>)}</ul>
    </div>
  );
}

const MARKET_SAMPLE = JSON.stringify({ name: "Ghana", defaultLanguage: "en", defaultCurrency: "GHS", defaultTimezone: "Africa/Accra", measurementSystem: "metric", workingDays: [1, 2, 3, 4, 5], isActive: false, currencies: [{ code: "GHS", isDefault: true }], languages: [{ code: "en", isDefault: true }], taxRules: [], holidays: [], paymentMethods: [], verificationRules: [], compliance: {} }, null, 2);
function Markets() {
  const m = useLoad(() => api<{ markets: { id: string; code: string; name: string; isActive: boolean; defaultCurrency: string }[] }>("GET", "/admin/markets"));
  return (
    <div className="space-y-4">
      <Note tone="info">A market is configuration, not code. Languages and currencies must already exist in their tables. A new market starts inactive.</Note>
      <ul className="space-y-2">{(m.data?.markets ?? []).map((x) => <Row key={x.id} className="flex items-center justify-between gap-2"><span className="font-semibold">{x.code} · {x.name}</span><span className="text-sm text-ink/60">{x.defaultCurrency} <Pill value={x.isActive ? "active" : "inactive"} /></span></Row>)}</ul>
      <Card title="Add or update a market">
        <SimpleForm submit="Save market" fields={[{ name: "code", label: "Code", required: true, placeholder: "GH", maxLength: 10 }, { name: "doc", label: "Configuration (JSON)", type: "textarea", required: true, defaultValue: MARKET_SAMPLE }]}
          onSubmit={async (v) => { let doc: unknown; try { doc = JSON.parse(String(v.doc)); } catch { throw new Error("The configuration is not valid JSON"); } await api("PUT", `/admin/markets/${String(v.code).toUpperCase()}`, doc); m.reload(); }} />
      </Card>
    </div>
  );
}

function Signals() {
  const ev = useLoad(() => api<{ events: { id: string; kind: string; severity: string; payload: Record<string, unknown>; createdAt: string }[] }>("GET", "/admin/events"));
  const ai = useLoad(() => api<{ byDay: { day: string; calls: number; costMicros: number }[]; byPurpose: { purpose: string; status: string; n: number }[] }>("GET", "/admin/ai-usage"));
  return (
    <div className="space-y-4">
      <Card title="AI use, last 14 days">{(ai.data?.byDay.length ?? 0) === 0 ? <p className="text-sm text-ink/60">No AI calls.</p> : <ul className="space-y-1 text-sm">{ai.data?.byDay.map((d) => <li key={d.day} className="flex justify-between"><span>{d.day}</span><span>{d.calls} calls · cost {d.costMicros}</span></li>)}</ul>}
        {(ai.data?.byPurpose.length ?? 0) > 0 && <p className="mt-3 text-xs text-ink/60">{ai.data?.byPurpose.map((p) => `${p.purpose}/${p.status}: ${p.n}`).join(" · ")}</p>}</Card>
      <Card title="Recent events" hint="AI, translation, payment, upload, SLA and job signals.">{(ev.data?.events.length ?? 0) === 0 ? <EmptyState title="Quiet" hint="No events recorded." /> : <ul className="space-y-1.5">{ev.data?.events.map((e) => <li key={e.id} className="rounded-lg border border-line p-2 text-sm"><div className="flex justify-between gap-2"><span className="font-semibold">{e.kind}</span><Pill value={e.severity} /></div><p className="mt-0.5 break-words font-mono text-[11px] text-ink/60">{JSON.stringify(e.payload)}</p><p className="text-[11px] text-ink/40">{dt(e.createdAt)}</p></li>)}</ul>}</Card>
    </div>
  );
}

function Policy() {
  const r = useLoad(() => api<{ policies: { id: string; dataClass: string; retainDays: number; note: string | null }[] }>("GET", "/admin/retention"));
  const c = useLoad(() => api<{ policies: { key: string; description: string | null; rules: { hoursBefore: number; feePercent: number }[] }[] }>("GET", "/cancellation-policies"));
  return (
    <div className="space-y-4">
      <Card title="Data retention" hint="How long each kind of record is kept. Review per market with counsel.">
        <SimpleForm columns={2} submit="Set" fields={[{ name: "dataClass", label: "Data", type: "select", options: ["chats", "financial", "identity", "evidence", "disputes", "deleted_accounts"].map((v) => ({ value: v, label: v.replaceAll("_", " ") })) }, { name: "retainDays", label: "Keep for (days)", type: "number", required: true }, { name: "marketCode", label: "Market (optional)", maxLength: 10 }]} onSubmit={async (v) => { await api("PUT", "/admin/retention", v); r.reload(); }} />
        <ul className="mt-3 space-y-1 text-sm">{(r.data?.policies ?? []).map((p) => <li key={p.id} className="flex justify-between"><span className="capitalize">{p.dataClass.replaceAll("_", " ")}</span><span>{p.retainDays} days</span></li>)}</ul>
      </Card>
      <Card title="Cancellation policies" hint="Set before a booking is confirmed. Each rule: from this many hours before the start, this percentage fee.">
        <ul className="mb-3 space-y-1 text-sm">{(c.data?.policies ?? []).map((p) => <li key={p.key}><span className="font-semibold">{p.key}</span>: {p.rules.map((x) => `${x.hoursBefore}h+ → ${x.feePercent}%`).join(", ")}</li>)}</ul>
        <SimpleForm columns={2} submit="Save policy" fields={[{ name: "key", label: "Key", required: true, placeholder: "strict" }, { name: "description", label: "Description", maxLength: 500 }, { name: "rules", label: "Rules (hours:fee, comma separated)", required: true, placeholder: "48:0, 12:50, 0:100" }]}
          onSubmit={async (v) => { const rules = String(v.rules).split(",").map((x) => x.trim().split(":").map(Number)).filter((p) => p.length === 2 && p.every((n) => Number.isFinite(n))).map(([h, f]) => ({ hoursBefore: h, feePercent: f })); if (rules.length === 0) throw new Error("Write rules like 48:0, 12:50, 0:100"); await api("PUT", "/cancellation-policies", { key: v.key, description: v.description, rules }); c.reload(); }} />
      </Card>
    </div>
  );
}
