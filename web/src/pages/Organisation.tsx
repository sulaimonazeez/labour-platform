import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, Row, SimpleForm, Stat, Tabs, day, useRun } from "../components/kit";
import { Button, EmptyState, Health, Note, Pill, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatMoney } from "../lib/money";
import { useLoad } from "../lib/useLoad";

// PRD §7-8, §76, §114-118: organisations, sites, budgets, approval chains, preferred providers and SLAs. Same engine as everyone else.
type Org = { id: string; name: string; type: string; roles: string[] };
type Structure = { departments: { id: string; name: string }[]; costCentres: { id: string; code: string; name: string }[]; sites: { id: string; name: string; regionRef: string | null }[] };
type Budget = { id: string; label: string; currency: string; amountMinor: number; periodStart: string; periodEnd: string; committedMinor: number; paidMinor: number; remainingMinor: number };
type Approval = { id: string; subjectType: string; amountMinor: number; currency: string; status: string; requiredRole: string | null; requestedByUserId: string; note: string | null; createdAt: string };
type Policy = { id: string; subjectType: string; thresholdMinor: number; currency: string; requiredRole: string };
type Overview = { projects: { id: string; title: string; status: string; health: string; currency: string }[]; paidByCurrencyMinor: Record<string, number> };

export default function Organisation() {
  const orgs = useLoad(() => api<{ organisations: Org[] }>("GET", "/orgs"));
  const [sel, setSel] = useState<string | null>(null);
  if (orgs.loading && !orgs.data) return <Skeleton className="h-40" />;
  const list = orgs.data?.organisations ?? [];
  const org = list.find((o) => o.id === sel) ?? list[0];
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Organisation</h1>
      {list.length > 1 && <select aria-label="Organisation" value={org?.id} onChange={(e) => setSel(e.target.value)} className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 font-semibold">{list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
      {!org ? (
        <>
          <EmptyState title="You are not in an organisation" hint="Create one for a business, institution or service company to get sites, budgets and approvals." />
          <Card title="Create an organisation"><SimpleForm submit="Create" fields={[{ name: "name", label: "Name", required: true, maxLength: 200 }, { name: "type", label: "Type", type: "select", options: ["business", "government", "ngo", "institution", "service_company", "merchant"].map((v) => ({ value: v, label: v.replaceAll("_", " ") })) }]} onSubmit={async (v) => { await api("POST", "/orgs", v); orgs.reload(); }} /></Card>
        </>
      ) : <OrgBody key={org.id} org={org} />}
    </div>
  );
}

function OrgBody({ org }: { org: Org }) {
  const { user } = useAuth();
  const [tab, setTab] = useState<"overview" | "structure" | "budgets" | "approvals" | "providers" | "sla" | "members">("overview");
  const isAdmin = org.roles.some((r) => ["owner", "admin"].includes(r));
  const isFinance = org.roles.some((r) => ["owner", "admin", "finance_approver"].includes(r));
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink/60">{org.name} · {org.type.replaceAll("_", " ")} · you are {org.roles.join(", ").replaceAll("_", " ")}</p>
      <Tabs tabs={[{ id: "overview", label: "Overview" }, { id: "structure", label: "Sites and teams" }, { id: "budgets", label: "Budgets" }, { id: "approvals", label: "Approvals" }, { id: "providers", label: "Preferred providers" }, { id: "sla", label: "Service levels" }, { id: "members", label: "People" }]} value={tab} onChange={setTab} />
      {tab === "overview" && <OverviewTab id={org.id} />}
      {tab === "structure" && <StructureTab id={org.id} isAdmin={isAdmin} />}
      {tab === "budgets" && <BudgetsTab id={org.id} canEdit={isFinance} />}
      {tab === "approvals" && <ApprovalsTab id={org.id} isAdmin={isAdmin} roles={org.roles} me={user?.id ?? ""} />}
      {tab === "providers" && <PreferredTab id={org.id} />}
      {tab === "sla" && <SlaTab id={org.id} isAdmin={isAdmin} />}
      {tab === "members" && <MembersTab id={org.id} isAdmin={isAdmin} />}
    </div>
  );
}

function OverviewTab({ id }: { id: string }) {
  const o = useLoad(() => api<Overview>("GET", `/orgs/${id}/overview`), [id]);
  if (!o.data) return <Skeleton className="h-32" />;
  return (
    <div className="space-y-4">
      <Card title="Paid so far" hint="Per currency. Currencies are never added together.">
        {Object.keys(o.data.paidByCurrencyMinor).length === 0 ? <p className="text-sm text-ink/60">Nothing released yet.</p> : <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{Object.entries(o.data.paidByCurrencyMinor).map(([c, n]) => <Stat key={c} label={c} value={formatMoney(n, c)} />)}</div>}
      </Card>
      <Card title={`Projects (${o.data.projects.length})`}>
        {o.data.projects.length === 0 ? <p className="text-sm text-ink/60">Projects created for this organisation appear here.</p> : <ul className="space-y-2">{o.data.projects.map((p) => <Row key={p.id}><Link to={`/projects/${p.id}`} className="flex items-center justify-between gap-2"><span className="font-medium">{p.title}</span><span className="text-xs"><Health value={p.health} /> · <Pill value={p.status} /></span></Link></Row>)}</ul>}
      </Card>
    </div>
  );
}

function StructureTab({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const s = useLoad(() => api<Structure>("GET", `/orgs/${id}/structure`), [id]);
  const d = s.data;
  return (
    <div className="space-y-4">
      <Card title="Sites and branches" hint="Recurring services and projects can be tied to a site.">
        {isAdmin && <SimpleForm columns={2} submit="Add site" fields={[{ name: "name", label: "Name", required: true, maxLength: 160 }, { name: "regionRef", label: "Region", maxLength: 120 }, { name: "timezone", label: "Time zone", placeholder: "Africa/Lagos", maxLength: 64 }]} onSubmit={async (v) => { await api("POST", `/orgs/${id}/sites`, v); s.reload(); }} />}
        <ul className="mt-3 space-y-1.5 text-sm">{(d?.sites ?? []).map((x) => <li key={x.id} className="flex justify-between"><span className="font-medium">{x.name}</span><span className="text-ink/50">{x.regionRef ?? ""}</span></li>)}</ul>
      </Card>
      <Card title="Departments">{isAdmin && <SimpleForm submit="Add department" fields={[{ name: "name", label: "Name", required: true, maxLength: 120 }]} onSubmit={async (v) => { await api("POST", `/orgs/${id}/departments`, v); s.reload(); }} />}<p className="mt-3 text-sm text-ink/70">{(d?.departments ?? []).map((x) => x.name).join(" · ") || "None yet"}</p></Card>
      <Card title="Cost centres">{isAdmin && <SimpleForm columns={2} submit="Add cost centre" fields={[{ name: "code", label: "Code", required: true, maxLength: 40 }, { name: "name", label: "Name", required: true, maxLength: 120 }]} onSubmit={async (v) => { await api("POST", `/orgs/${id}/cost-centres`, v); s.reload(); }} />}<p className="mt-3 text-sm text-ink/70">{(d?.costCentres ?? []).map((x) => `${x.code} ${x.name}`).join(" · ") || "None yet"}</p></Card>
    </div>
  );
}

function BudgetsTab({ id, canEdit }: { id: string; canEdit: boolean }) {
  const b = useLoad(() => api<{ budgets: Budget[] }>("GET", `/orgs/${id}/budgets`), [id]);
  const year = new Date().getFullYear();
  return (
    <div className="space-y-4">
      {canEdit && <Card title="Set a budget" hint="Amounts are in minor units of the currency (for example kobo or cents)."><SimpleForm columns={2} submit="Add budget" fields={[{ name: "label", label: "Label", required: true, maxLength: 160 }, { name: "currency", label: "Currency", defaultValue: "NGN", required: true, maxLength: 3 }, { name: "amountMinor", label: "Amount (minor units)", type: "number", required: true }, { name: "spendLimitMinor", label: "Per-purchase limit", type: "number" }, { name: "periodStart", label: "From", type: "date", defaultValue: `${year}-01-01`, required: true }, { name: "periodEnd", label: "Until", type: "date", defaultValue: `${year}-12-31`, required: true }]} onSubmit={async (v) => { await api("POST", `/orgs/${id}/budgets`, v); b.reload(); }} /></Card>}
      {(b.data?.budgets.length ?? 0) === 0 ? <EmptyState title="No budgets" hint="Budgets show the limit, what is committed and what is paid." /> : <ul className="space-y-2">{b.data?.budgets.map((x) => { const pct = x.amountMinor > 0 ? Math.min(100, Math.round((x.committedMinor / x.amountMinor) * 100)) : 0; return <Row key={x.id}><div className="flex justify-between gap-2"><span className="font-semibold">{x.label}</span><span className="text-sm text-ink/60">{day(x.periodStart)} to {day(x.periodEnd)}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-brand/10"><div className="h-full bg-gold" style={{ width: `${pct}%` }} /></div><p className="mt-1.5 text-sm text-ink/70">{formatMoney(x.committedMinor, x.currency)} committed of {formatMoney(x.amountMinor, x.currency)} · {formatMoney(x.paidMinor, x.currency)} paid · {formatMoney(x.remainingMinor, x.currency)} left</p></Row>; })}</ul>}
    </div>
  );
}

function ApprovalsTab({ id, isAdmin, roles, me }: { id: string; isAdmin: boolean; roles: string[]; me: string }) {
  const list = useLoad(() => api<{ approvals: Approval[] }>("GET", `/orgs/${id}/approval-requests`), [id]);
  const pol = useLoad(() => api<{ policies: Policy[] }>("GET", `/orgs/${id}/approval-policies`), [id]);
  const { busy, run } = useRun();
  const canDecide = (a: Approval) => a.status === "pending" && a.requestedByUserId !== me && (roles.includes("owner") || (a.requiredRole !== null && roles.includes(a.requiredRole)));
  return (
    <div className="space-y-4">
      <Card title="Waiting for a decision">
        {(list.data?.approvals.filter((a) => a.status === "pending").length ?? 0) === 0 ? <p className="text-sm text-ink/60">Nothing is waiting.</p> : <ul className="space-y-2">{list.data?.approvals.filter((a) => a.status === "pending").map((a) => <Row key={a.id}><div className="flex items-start justify-between gap-2"><div><p className="font-semibold capitalize">{a.subjectType} · {formatMoney(a.amountMinor, a.currency)}</p><p className="text-xs text-ink/60">Needs {a.requiredRole?.replaceAll("_", " ")} · {day(a.createdAt)}</p></div><Pill value={a.status} /></div>{canDecide(a) ? <div className="mt-2 flex gap-2"><Button variant="gold" busy={busy === `a${a.id}`} onClick={() => void run(`a${a.id}`, () => api("POST", `/approvals/${a.id}/decide`, { decision: "approved" }), "Approved", list.reload)}>Approve</Button><Button variant="quiet" busy={busy === `r${a.id}`} onClick={() => void run(`r${a.id}`, () => api("POST", `/approvals/${a.id}/decide`, { decision: "rejected" }), "Rejected", list.reload)}>Reject</Button></div> : a.requestedByUserId === me ? <p className="mt-2 text-xs text-ink/50">You asked for this, so someone else decides.</p> : null}</Row>)}</ul>}
      </Card>
      <Card title="Approval rules" hint="Above the threshold, a purchase or change needs someone in the named role to approve it.">
        {isAdmin && <SimpleForm columns={2} submit="Add rule" fields={[{ name: "subjectType", label: "Applies to", type: "select", options: ["procurement", "quote", "project", "change", "payment", "milestone"].map((v) => ({ value: v, label: v })) }, { name: "thresholdMinor", label: "From amount (minor units)", type: "number", required: true }, { name: "currency", label: "Currency", defaultValue: "NGN", required: true, maxLength: 3 }, { name: "requiredRole", label: "Approver", type: "select", options: ["finance_approver", "procurement_officer", "project_manager", "admin", "owner"].map((v) => ({ value: v, label: v.replaceAll("_", " ") })) }]} onSubmit={async (v) => { await api("POST", `/orgs/${id}/approval-policies`, v); pol.reload(); }} />}
        <ul className="mt-3 space-y-1.5 text-sm">{(pol.data?.policies ?? []).map((p) => <li key={p.id}><span className="font-medium capitalize">{p.subjectType}</span> from {formatMoney(p.thresholdMinor, p.currency)} needs {p.requiredRole.replaceAll("_", " ")}</li>)}</ul>
      </Card>
      <Card title="Ask for approval" hint="Raise a request for something that needs a decision. Under every threshold it is cleared automatically.">
        <SimpleForm columns={2} submit="Request" fields={[{ name: "subjectType", label: "For", type: "select", options: ["procurement", "quote", "project", "change", "payment", "milestone"].map((v) => ({ value: v, label: v })) }, { name: "subjectId", label: "Reference id", required: true, hint: "Paste the id of the project, quote or request" }, { name: "amountMinor", label: "Amount (minor units)", type: "number", required: true }, { name: "currency", label: "Currency", defaultValue: "NGN", required: true, maxLength: 3 }, { name: "note", label: "Note", maxLength: 1000 }]} onSubmit={async (v) => { await api("POST", `/orgs/${id}/approval-requests`, v); list.reload(); }} />
      </Card>
      {(list.data?.approvals.filter((a) => a.status !== "pending").length ?? 0) > 0 && <Card title="Decided"><ul className="space-y-1.5 text-sm">{list.data?.approvals.filter((a) => a.status !== "pending").slice(0, 20).map((a) => <li key={a.id} className="flex justify-between"><span className="capitalize">{a.subjectType} · {formatMoney(a.amountMinor, a.currency)}</span><Pill value={a.status} /></li>)}</ul></Card>}
    </div>
  );
}

function PreferredTab({ id }: { id: string }) {
  const list = useLoad(() => api<{ providers: { providerId: string; name: string; headline: string | null; categoryKey: string; note: string | null }[] }>("GET", `/orgs/${id}/preferred-providers`), [id]);
  return (
    <div className="space-y-4">
      <Card title="Add a preferred provider" hint="Preferred providers are invited first. Find their id on the Find page."><SimpleForm columns={2} submit="Add" fields={[{ name: "providerProfileId", label: "Provider id", required: true }, { name: "categoryKey", label: "For service (optional)", maxLength: 120, placeholder: "plumbing_residential" }, { name: "note", label: "Note", maxLength: 500 }]} onSubmit={async (v) => { await api("POST", `/orgs/${id}/preferred-providers`, v); list.reload(); }} /></Card>
      {(list.data?.providers.length ?? 0) === 0 ? <EmptyState title="No preferred providers" hint="Add the ones you trust." /> : <ul className="space-y-2">{list.data?.providers.map((p) => <Row key={`${p.providerId}${p.categoryKey}`} className="flex justify-between gap-2"><span><span className="font-semibold">{p.name}</span><span className="block text-xs text-ink/60">{p.headline ?? ""}</span></span><span className="text-xs text-ink/60">{p.categoryKey || "any service"}</span></Row>)}</ul>}
    </div>
  );
}

function SlaTab({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const rep = useLoad(() => api<{ report: { policies: number; measured: { responses: number; arrivals: number; completedTasks: number }; breaches: { response: number | null; arrival: number | null; completion: number | null }; completedLateAgainstPlan: number; note: string } }>("GET", `/orgs/${id}/sla-report`).catch(() => null), [id]);
  return (
    <div className="space-y-4">
      {isAdmin && <Card title="Set a service level" hint="Leave a field empty to not measure it."><SimpleForm columns={2} submit="Save" fields={[{ name: "categoryKey", label: "Service (optional)", maxLength: 120 }, { name: "responseMinutes", label: "First quote within (minutes)", type: "number" }, { name: "arrivalMinutes", label: "Arrive within (minutes of booking)", type: "number" }, { name: "completionHours", label: "Finish within (hours)", type: "number" }]} onSubmit={async (v) => { await api("POST", `/orgs/${id}/sla-policies`, v); rep.reload(); }} /></Card>}
      <Card title="How providers are doing" hint="Only what the recorded timestamps can measure.">
        {!rep.data ? <p className="text-sm text-ink/60">No report available for your role.</p> : (
          <div className="space-y-3"><div className="grid grid-cols-3 gap-2"><Stat label="Quote breaches" value={rep.data.report.breaches.response ?? "n/a"} /><Stat label="Arrival breaches" value={rep.data.report.breaches.arrival ?? "n/a"} /><Stat label="Completion breaches" value={rep.data.report.breaches.completion ?? "n/a"} /></div><p className="text-sm text-ink/70">{rep.data.report.measured.completedTasks} finished tasks measured. {rep.data.report.completedLateAgainstPlan} finished after their planned date.</p><Note tone="info">{rep.data.report.note}</Note></div>
        )}
      </Card>
    </div>
  );
}

function MembersTab({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const m = useLoad(() => api<{ members: { userId: string; name: string; email: string | null; role: string }[] }>("GET", `/orgs/${id}/members`), [id]);
  return (
    <div className="space-y-4">
      {isAdmin && <Card title="Add a person" hint="They need an account already."><SimpleForm columns={2} submit="Add" fields={[{ name: "email", label: "Email", type: "email", required: true }, { name: "role", label: "Role", type: "select", defaultValue: "member", options: ["member", "project_manager", "finance_approver", "procurement_officer", "auditor", "admin", "owner"].map((v) => ({ value: v, label: v.replaceAll("_", " ") })) }]} onSubmit={async (v) => { await api("POST", `/orgs/${id}/members`, v); m.reload(); }} /></Card>}
      <ul className="space-y-2">{(m.data?.members ?? []).map((x, i) => <Row key={`${x.userId}${i}`} className="flex justify-between gap-2"><span><span className="font-semibold">{x.name}</span><span className="block text-xs text-ink/60">{x.email}</span></span><Pill value={x.role} /></Row>)}</ul>
    </div>
  );
}
