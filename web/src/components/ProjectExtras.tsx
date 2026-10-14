import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatMoney } from "../lib/money";
import { useToast } from "../lib/toast";
import { useLoad } from "../lib/useLoad";
import { ContextChat, type ChatType } from "./ContextChat";
import { Card, Row, SimpleForm, Stat, Tabs, TrustBadge, dt, useRun } from "./kit";
import { Button, EmptyState, Health, Note, Pill, Skeleton } from "./ui";

// Everything the PRD adds to a project (PRD §31, §54, §59, §65, §71-79, §101-104, §138-144), kept out of ProjectPage
// so that page stays readable. Providers only ever see what the server returns for their own tasks (PRD §34).

type TaskLite = { id: string; title: string; status: string; stageId: string | null };
type StageLite = { id: string; name: string };
type Props = { projectId: string; currency: string; isManager: boolean; providerOnly: boolean; tasks: TaskLite[]; stages: StageLite[]; onChanged: () => void };
type TabId = "brief" | "chat" | "schedule" | "updates" | "issues" | "disputes" | "documents" | "procurement" | "handover";

export function ProjectExtras(p: Props) {
  const tabs: { id: TabId; label: string }[] = p.providerOnly
    ? [{ id: "chat", label: "Chat" }, { id: "schedule", label: "Schedule" }, { id: "updates", label: "Updates" }, { id: "issues", label: "Issues" }, { id: "disputes", label: "Disputes" }, { id: "documents", label: "Documents" }]
    : [{ id: "brief", label: "Brief" }, { id: "chat", label: "Chat" }, { id: "schedule", label: "Schedule" }, { id: "updates", label: "Updates" }, { id: "issues", label: "Issues" }, { id: "disputes", label: "Disputes" }, { id: "documents", label: "Documents" }, { id: "procurement", label: "Materials" }, { id: "handover", label: "Handover" }];
  const [tab, setTab] = useState<TabId>(tabs[0].id);
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Run the project</h2>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "brief" && <BriefPanel {...p} />}
      {tab === "chat" && <ChatPanel {...p} />}
      {tab === "schedule" && <SchedulePanel {...p} />}
      {tab === "updates" && <UpdatesPanel {...p} />}
      {tab === "issues" && <IssuesPanel {...p} />}
      {tab === "disputes" && <DisputesPanel {...p} />}
      {tab === "documents" && <DocumentsPanel {...p} />}
      {tab === "procurement" && <ProcurementPanel {...p} />}
      {tab === "handover" && <HandoverPanel {...p} />}
    </section>
  );
}

const taskOptions = (tasks: TaskLite[], none?: string) => [...(none ? [{ value: "", label: none }] : []), ...tasks.map((t) => ({ value: t.id, label: t.title }))];

// ── brief, assistant, quote comparison (PRD §33, §54, §77, §144) ─────────────
type Brief = {
  derivedHealth: string; storedHealth: string; progress: { total: number; done: number; ratio: number }; next: { kind: string; text: string }[];
  late: { taskId: string; title: string }[]; blocked: { taskId: string; title: string }[]; summary: string; source: "record" | "ai"; aiProvider?: string;
  money: { estimatedMinor: number | null; approvedMinor: number | null; notFundedMinor: number; heldMinor: number; releasedMinor: number; disputedMinor: number } | null;
  counts: { openIssues: number; pendingChanges: number; openDisputes: number };
};
type Compare = { comparable: boolean; lowestQuoteId: string | null; quotes: { quoteId: string; provider: string; totalMinor: number; currency: string; version: number; status: string }[]; warnings: string[]; summary: string; source: "record" | "ai" };

function BriefPanel({ projectId, currency, isManager, tasks, onChanged }: Props) {
  const brief = useLoad(() => api<{ brief: Brief }>("GET", `/projects/${projectId}/brief`), [projectId]);
  const { busy, run } = useRun();
  const [q, setQ] = useState("");
  const [ans, setAns] = useState<{ answer: string; source: "record" | "ai"; answered: boolean } | null>(null);
  const [cmpTask, setCmpTask] = useState(tasks[0]?.id ?? "");
  const [cmp, setCmp] = useState<Compare | null>(null);
  const b = brief.data?.brief;
  if (brief.loading && !b) return <Skeleton className="h-40" />;
  if (!b) return <Note>{brief.error ?? "No brief"}</Note>;
  return (
    <div className="space-y-4">
      <Card title="Where things stand" action={<TrustBadge source={b.source} />}>
        <p className="text-sm"><Health value={b.derivedHealth} />{b.derivedHealth !== b.storedHealth && <span className="ml-2 text-xs text-ink/50">saved as {b.storedHealth.replaceAll("_", " ")}</span>}</p>
        <p className="mt-2 text-ink/80">{b.summary}</p>
        <div className="mt-3 grid grid-cols-3 gap-2"><Stat label="Tasks done" value={`${b.progress.done}/${b.progress.total}`} /><Stat label="Open issues" value={b.counts.openIssues} /><Stat label="Pending changes" value={b.counts.pendingChanges} /></div>
        {isManager && b.derivedHealth !== b.storedHealth && <Button className="mt-3" variant="quiet" busy={busy === "health"} onClick={() => void run("health", () => api("POST", `/projects/${projectId}/recompute-health`, {}), "Health updated", () => { brief.reload(); onChanged(); })}>Save this health to the project</Button>}
      </Card>
      {b.next.length > 0 && <Card title="Next actions"><ul className="space-y-2 text-sm">{b.next.map((n, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gold" />{n.text}</li>)}</ul></Card>}
      {b.money && (
        <Card title="Money" hint="Held is secured but not yet released. Nothing here adds different currencies together.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Approved budget" value={b.money.approvedMinor === null ? "Not set" : formatMoney(b.money.approvedMinor, currency)} />
            <Stat label="Not funded" value={formatMoney(b.money.notFundedMinor, currency)} /><Stat label="Held" value={formatMoney(b.money.heldMinor, currency)} />
            <Stat label="Released" value={formatMoney(b.money.releasedMinor, currency)} /><Stat label="Disputed" value={formatMoney(b.money.disputedMinor, currency)} />
          </div>
        </Card>
      )}
      <Card title="Ask about this project" hint="Answers come from the accepted scope, tasks and approved changes. It will say when the record does not cover it.">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim().length > 1) void run("ask", async () => setAns(await api("POST", `/projects/${projectId}/assistant/ask`, { question: q.trim() }))); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={1000} placeholder="What is expected before I submit this task?" className="w-full rounded-xl border border-line bg-surface px-3 py-2.5" />
          <Button type="submit" busy={busy === "ask"}>Ask</Button>
        </form>
        {ans && <div className="mt-3 rounded-xl bg-brand/5 p-3 text-sm"><p className="whitespace-pre-wrap">{ans.answer}</p><p className="mt-2"><TrustBadge source={ans.source} /></p></div>}
      </Card>
      {isManager && tasks.length > 0 && (
        <Card title="Compare quotes" hint="Informational. Quotes are shown as the provider submitted them.">
          <div className="flex gap-2">
            <select value={cmpTask} onChange={(e) => { setCmpTask(e.target.value); setCmp(null); }} className="w-full rounded-xl border border-line bg-surface px-3 py-2.5">{taskOptions(tasks).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            <Button variant="quiet" busy={busy === "cmp"} onClick={() => void run("cmp", async () => setCmp((await api<{ comparison: Compare }>("GET", `/tasks/${cmpTask}/quotes/compare`)).comparison))}>Compare</Button>
          </div>
          {cmp && (
            <div className="mt-3 space-y-2 text-sm">
              {cmp.quotes.length === 0 ? <p className="text-ink/60">{cmp.summary}</p> : (
                <ul className="space-y-2">{cmp.quotes.map((x) => <Row key={x.quoteId} className="flex items-center justify-between gap-2"><span className="font-medium">{x.provider} <span className="text-xs text-ink/50">v{x.version}</span></span><span className="font-semibold">{formatMoney(x.totalMinor, x.currency)}{x.quoteId === cmp.lowestQuoteId ? <span className="ml-2 rounded-full bg-signal/15 px-2 py-0.5 text-xs text-signal">lowest</span> : null}</span></Row>)}</ul>
              )}
              {cmp.warnings.map((w, i) => <Note key={i} tone="info">{w}</Note>)}
              <p className="text-ink/70">{cmp.summary} <TrustBadge source={cmp.source} /></p>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ── chat contexts (PRD §31) ──────────────────────────────────────────────────
function ChatPanel({ projectId, providerOnly, tasks, stages }: Props) {
  const initial: { type: ChatType; id: string } = providerOnly ? { type: "task", id: tasks[0]?.id ?? "" } : { type: "project", id: projectId };
  const [ctx, setCtx] = useState(initial);
  const options = useMemo(() => [
    ...(providerOnly ? [] : [{ k: `project:${projectId}`, label: "Whole project" }]),
    ...(providerOnly ? [] : stages.map((s) => ({ k: `stage:${s.id}`, label: `Stage: ${s.name}` }))),
    ...tasks.map((t) => ({ k: `task:${t.id}`, label: `Task: ${t.title}` })),
  ], [projectId, providerOnly, stages, tasks]);
  if (!ctx.id) return <EmptyState title="Nothing to talk about yet" hint="Task chats open when you are assigned a task." />;
  return (
    <Card>
      <select aria-label="Conversation" value={`${ctx.type}:${ctx.id}`} onChange={(e) => { const [t, ...rest] = e.target.value.split(":"); setCtx({ type: t as ChatType, id: rest.join(":") }); }} className="mb-3 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm font-semibold">
        {options.map((o) => <option key={o.k} value={o.k}>{o.label}</option>)}
      </select>
      <ContextChat key={`${ctx.type}:${ctx.id}`} type={ctx.type} id={ctx.id} />
    </Card>
  );
}

// ── schedule and check-in (PRD §71-75) ───────────────────────────────────────
type Booking = { id: string; status: string; startsAt: string; endsAt: string; travelBufferMin: number; proposedByUserId: string; note: string | null; cancellationPolicyKey: string | null };
const WARN_TEXT: Record<string, string> = {
  non_working_day: "falls on a day this market does not usually work", public_holiday: "falls on a public holiday", outside_availability: "is outside the provider's published hours",
  provider_marked_unavailable: "overlaps time the provider marked unavailable", overlaps_proposed_booking: "overlaps another proposed booking",
};

function SchedulePanel({ isManager, tasks, projectId }: Props) {
  const { user } = useAuth();
  const toast = useToast();
  const { busy, run } = useRun();
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const [moving, setMoving] = useState<string | null>(null);
  const list = useLoad(() => (taskId ? api<{ bookings: Booking[] }>("GET", `/tasks/${taskId}/bookings`) : Promise.resolve({ bookings: [] as Booking[] })), [taskId]);
  const checks = useLoad(() => (taskId ? api<{ checkIns: { id: string; kind: string; etaMinutes: number | null; createdAt: string }[] }>("GET", `/tasks/${taskId}/check-ins`).catch(() => ({ checkIns: [] })) : Promise.resolve({ checkIns: [] })), [taskId]);
  if (tasks.length === 0) return <EmptyState title="No tasks yet" hint="Bookings attach to a task once a provider has been chosen." />;
  const rows = list.data?.bookings ?? [];
  const live = rows.filter((b) => !["cancelled", "rescheduled"].includes(b.status));
  const warnNote = (w: string[]) => { if (w.length > 0) toast.success(`Saved. Note: this time ${w.map((x) => WARN_TEXT[x] ?? x).join("; ")}.`); };

  return (
    <div className="space-y-4">
      <select aria-label="Task" value={taskId} onChange={(e) => setTaskId(e.target.value)} className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm font-semibold">{taskOptions(tasks).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      {list.error && <Note>{list.error}</Note>}
      <Card title="Booked times" hint="Times are shown in your own time zone.">
        {live.length === 0 ? <p className="text-sm text-ink/60">Nothing booked.</p> : (
          <ul className="space-y-2">
            {live.map((b) => {
              const past = new Date(b.startsAt).getTime() < Date.now();
              return (
                <Row key={b.id}>
                  <div className="flex items-start justify-between gap-2"><div><p className="font-medium">{dt(b.startsAt)} to {dt(b.endsAt)}</p><p className="text-xs text-ink/60">{b.travelBufferMin > 0 ? `${b.travelBufferMin} min travel buffer · ` : ""}cancellation policy: {b.cancellationPolicyKey ?? "default"}</p></div><Pill value={b.status} /></div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {b.status === "proposed" && b.proposedByUserId !== user?.id && <Button variant="gold" busy={busy === `c${b.id}`} onClick={() => void run(`c${b.id}`, () => api("POST", `/bookings/${b.id}/confirm`, {}), "Confirmed", list.reload)}>Confirm</Button>}
                    {["proposed", "confirmed"].includes(b.status) && <Button variant="quiet" onClick={() => setMoving(moving === b.id ? null : b.id)}>Move</Button>}
                    {["proposed", "confirmed"].includes(b.status) && <Button variant="quiet" busy={busy === `x${b.id}`} onClick={() => { if (window.confirm("Cancel this booking?")) void run(`x${b.id}`, async () => { const r = await api<{ policy: { feePercent: number } }>("POST", `/bookings/${b.id}/cancel`, {}); if (r.policy.feePercent > 0) toast.success(`Cancelled. The policy applies a ${r.policy.feePercent}% fee.`); }, "Cancelled", list.reload); }}>Cancel</Button>}
                    {b.status === "confirmed" && past && <Button variant="quiet" busy={busy === `n${b.id}`} onClick={() => void run(`n${b.id}`, () => api("POST", `/bookings/${b.id}/no-show`, { party: isManager ? "provider" : "customer" }), "Recorded", list.reload)}>{isManager ? "Provider did not come" : "Customer was not there"}</Button>}
                  </div>
                  {moving === b.id && (
                    <div className="mt-3 border-t border-line pt-3">
                      <SimpleForm columns={2} submit="Propose new time" fields={[{ name: "startsAt", label: "Starts", type: "datetime", required: true }, { name: "endsAt", label: "Ends", type: "datetime", required: true }]}
                        onSubmit={async (v) => { const r = await api<{ warnings: string[] }>("POST", `/bookings/${b.id}/reschedule`, v); warnNote(r.warnings); setMoving(null); list.reload(); }} />
                    </div>
                  )}
                </Row>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="Propose a time">
        <SimpleForm columns={2} submit="Propose" fields={[
          { name: "startsAt", label: "Starts", type: "datetime", required: true }, { name: "endsAt", label: "Ends", type: "datetime", required: true },
          { name: "travelBufferMin", label: "Travel buffer (minutes)", type: "number", defaultValue: "0" }, { name: "note", label: "Note", type: "text", maxLength: 500 },
        ]} onSubmit={async (v) => { const r = await api<{ warnings: string[] }>("POST", `/tasks/${taskId}/bookings`, v); warnNote(r.warnings); list.reload(); }} />
      </Card>
      {!isManager && (
        <Card title="On the day" hint="Optional. Only a coarse status is shared, never continuous location.">
          <div className="flex flex-wrap gap-2">
            {(["en_route", "arrived", "started", "left"] as const).map((k) => (
              <Button key={k} variant="quiet" busy={busy === k} onClick={() => void run(k, () => new Promise<void>((resolve, reject) => {
                const send = (lat?: number, lng?: number) => api("POST", `/tasks/${taskId}/check-in`, { kind: k, ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}) }).then(() => resolve(), reject);
                if (k === "arrived" && "geolocation" in navigator) navigator.geolocation.getCurrentPosition((p) => void send(p.coords.latitude, p.coords.longitude), () => void send(), { timeout: 4000 });
                else void send();
              }), "Shared", checks.reload)}>{k.replaceAll("_", " ")}</Button>
            ))}
          </div>
        </Card>
      )}
      {(checks.data?.checkIns.length ?? 0) > 0 && <Card title="Check-ins"><ul className="space-y-1 text-sm">{checks.data?.checkIns.map((c) => <li key={c.id} className="flex justify-between"><span className="font-medium">{c.kind.replaceAll("_", " ")}{c.etaMinutes ? ` · ${c.etaMinutes} min` : ""}</span><span className="text-ink/60">{dt(c.createdAt)}</span></li>)}</ul></Card>}
      <p className="text-xs text-ink/50">Project <Link className="underline" to={`/projects/${projectId}`}>{projectId.slice(0, 8)}</Link></p>
    </div>
  );
}

// ── updates ──────────────────────────────────────────────────────────────────
function UpdatesPanel({ projectId, tasks, providerOnly }: Props) {
  const list = useLoad(() => api<{ updates: { id: string; kind: string; body: string; taskId: string | null; createdAt: string }[] }>("GET", `/projects/${projectId}/updates`), [projectId]);
  const title = (id: string | null) => tasks.find((t) => t.id === id)?.title;
  return (
    <div className="space-y-4">
      <Card title="Post an update" hint="Blockers and material requests notify the project manager.">
        <SimpleForm submit="Post" fields={[
          { name: "kind", label: "Type", type: "select", options: [{ value: "progress", label: "Progress" }, { value: "blocker", label: "Blocker" }, { value: "material_request", label: "Material request" }, { value: "note", label: "Note" }] },
          { name: "taskId", label: "Task", type: "select", options: taskOptions(tasks, providerOnly ? undefined : "Whole project") }, { name: "body", label: "What is happening", type: "textarea", required: true, maxLength: 4000 },
        ]} onSubmit={async (v) => { await api("POST", `/projects/${projectId}/updates`, v); list.reload(); }} />
      </Card>
      {list.loading && !list.data ? <Skeleton className="h-20" /> : (list.data?.updates.length ?? 0) === 0 ? <EmptyState title="No updates yet" hint="Progress notes appear here in order." /> : (
        <ul className="space-y-2">{list.data?.updates.map((u) => <Row key={u.id}><div className="flex items-center justify-between gap-2"><Pill value={u.kind} /><span className="text-xs text-ink/50">{dt(u.createdAt)}</span></div><p className="mt-1.5 whitespace-pre-wrap text-sm">{u.body}</p>{u.taskId && <p className="mt-1 text-xs text-ink/50">Task: {title(u.taskId) ?? u.taskId.slice(0, 8)}</p>}</Row>)}</ul>
      )}
    </div>
  );
}

// ── issues and safety (PRD §78-79) ───────────────────────────────────────────
type Issue = { id: string; title: string; description: string | null; category: string; severity: string; status: string; resolution: string | null };
function IssuesPanel({ projectId, isManager, tasks }: Props) {
  const list = useLoad(() => api<{ issues: Issue[] }>("GET", `/projects/${projectId}/issues`), [projectId]);
  const { busy, run } = useRun();
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState("");
  return (
    <div className="space-y-4">
      <Card title="Raise an issue" hint="Issues are not change requests. They track a problem until it is resolved.">
        <SimpleForm columns={2} submit="Raise issue" fields={[
          { name: "title", label: "What is the problem", required: true, maxLength: 200 },
          { name: "category", label: "Kind", type: "select", options: ["material_unavailable", "site_inaccessible", "safety_risk", "defective_equipment", "provider_delay", "dependency_blocked", "other"].map((v) => ({ value: v, label: v.replaceAll("_", " ") })) },
          { name: "severity", label: "How serious", type: "select", defaultValue: "medium", options: ["low", "medium", "high", "critical"].map((v) => ({ value: v, label: v })) },
          { name: "affectedTaskId", label: "Affects task", type: "select", options: taskOptions(tasks, "No specific task") },
          { name: "description", label: "Details", type: "textarea", maxLength: 4000 },
        ]} onSubmit={async (v) => { const { affectedTaskId, ...rest } = v; await api("POST", `/projects/${projectId}/issues`, { ...rest, affectedTaskIds: affectedTaskId ? [affectedTaskId] : [] }); list.reload(); }} />
        <p className="mt-3 text-xs text-ink/60">Someone hurt, fire, gas or a break-in? Call local emergency services first, then <Link className="font-semibold underline" to={`/safety?project=${projectId}`}>report a safety incident</Link>.</p>
      </Card>
      {list.loading && !list.data ? <Skeleton className="h-20" /> : (list.data?.issues.length ?? 0) === 0 ? <EmptyState title="No issues" hint="Good. Problems you raise appear here." /> : (
        <ul className="space-y-2">
          {list.data?.issues.map((i) => (
            <Row key={i.id}>
              <div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{i.title}</p><p className="text-xs text-ink/60">{i.category.replaceAll("_", " ")} · {i.severity}</p></div><Pill value={i.status} /></div>
              {i.description && <p className="mt-1 text-sm text-ink/80">{i.description}</p>}
              {i.resolution && <p className="mt-1 text-sm text-signal">Resolution: {i.resolution}</p>}
              {isManager && ["open", "acknowledged"].includes(i.status) && (
                <div className="mt-2 space-y-2">
                  <div className="flex gap-2">
                    {i.status === "open" && <Button variant="quiet" busy={busy === `a${i.id}`} onClick={() => void run(`a${i.id}`, () => api("POST", `/issues/${i.id}/status`, { status: "acknowledged" }), "Acknowledged", list.reload)}>Acknowledge</Button>}
                    <Button variant="quiet" onClick={() => setResolving(resolving === i.id ? null : i.id)}>Resolve</Button>
                  </div>
                  {resolving === i.id && <div className="flex gap-2"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="How was it resolved?" className="w-full rounded-xl border border-line bg-surface px-3 py-2" /><Button busy={busy === `r${i.id}`} disabled={note.trim().length < 2} onClick={() => void run(`r${i.id}`, () => api("POST", `/issues/${i.id}/status`, { status: "resolved", resolution: note.trim() }), "Resolved", () => { setNote(""); setResolving(null); list.reload(); })}>Save</Button></div>}
                </div>
              )}
            </Row>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── disputes (PRD §101-104) ──────────────────────────────────────────────────
function DisputesPanel({ projectId, tasks }: Props) {
  const list = useLoad(() => api<{ disputes: { id: string; scopeType: string; reason: string; status: string; amountMinor: number | null; currency: string | null; createdAt: string }[] }>("GET", `/projects/${projectId}/disputes`), [projectId]);
  const ms = useLoad(() => api<{ milestones: { id: string; title: string; status: string }[] }>("GET", `/projects/${projectId}/milestones`), [projectId]);
  const [scope, setScope] = useState("task");
  const scopeOptions = scope === "milestone" ? (ms.data?.milestones ?? []).map((m) => ({ value: m.id, label: `${m.title} (${m.status})` })) : taskOptions(tasks);
  return (
    <div className="space-y-4">
      <Card title="Open a dispute" hint="A dispute covers one task or one milestone. Only that amount is held. Everything else carries on.">
        <div className="mb-3 flex gap-2">{(["task", "milestone"] as const).map((s) => <Button key={s} variant={scope === s ? "primary" : "quiet"} onClick={() => setScope(s)}>{s === "task" ? "A task" : "A milestone"}</Button>)}</div>
        <SimpleForm key={scope} submit="Open dispute" fields={[
          { name: "scopeId", label: scope === "task" ? "Which task" : "Which milestone", type: "select", options: scopeOptions },
          { name: "reason", label: "Reason", type: "select", options: ["not_completed", "poor_quality", "not_as_described", "no_show", "price_dispute", "scope_disagreement", "payment_issue", "safety", "other"].map((v) => ({ value: v, label: v.replaceAll("_", " ") })) },
          { name: "description", label: "What happened (facts first)", type: "textarea", maxLength: 4000 },
        ]} onSubmit={async (v) => { await api("POST", `/projects/${projectId}/disputes`, { scopeType: scope, ...v }); list.reload(); ms.reload(); }} />
      </Card>
      {(list.data?.disputes.length ?? 0) === 0 ? <EmptyState title="No disputes" hint="Good documentation up front keeps it that way." /> : (
        <ul className="space-y-2">{list.data?.disputes.map((d) => (
          <Row key={d.id}><Link to={`/disputes/${d.id}`} className="flex items-center justify-between gap-2"><span><span className="font-semibold">{d.reason.replaceAll("_", " ")}</span><span className="ml-2 text-xs text-ink/60">{d.scopeType}{d.amountMinor !== null && d.currency ? ` · ${formatMoney(d.amountMinor, d.currency)}` : ""}</span></span><Pill value={d.status} /></Link></Row>
        ))}</ul>
      )}
    </div>
  );
}

// ── documents (PRD §138) ─────────────────────────────────────────────────────
type Doc = { id: string; name: string; kind: string; version: number; current: boolean; url: string | null; createdAt: string };
const DOC_KINDS = ["specification", "drawing", "invoice", "receipt", "contract", "certificate", "inspection_report", "warranty", "manual", "other"];
function DocumentsPanel({ projectId, isManager, tasks }: Props) {
  const list = useLoad(() => api<{ documents: Doc[] }>("GET", `/projects/${projectId}/documents`), [projectId]);
  const { busy, run } = useRun();
  const file = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState("other");
  const [taskId, setTaskId] = useState("");
  const [managersOnly, setManagersOnly] = useState(false);
  async function upload(f: File) {
    const issued = await api<{ storagePath: string; upload: { url: string; method: string; headers: Record<string, string> } }>("POST", `/projects/${projectId}/documents/upload-url`, { mimeType: f.type, sizeBytes: f.size });
    const put = await fetch(issued.upload.url, { method: issued.upload.method, headers: issued.upload.headers, body: f });
    if (!put.ok) throw new Error(`The upload did not finish (${put.status})`);
    await api("POST", `/projects/${projectId}/documents`, { name: f.name, kind, storagePath: issued.storagePath, mimeType: f.type, ...(taskId ? { taskId } : {}), managersOnly });
    list.reload();
  }
  return (
    <div className="space-y-4">
      <Card title="Add a document" hint="PDF or image. Adding a file with the same name creates a new version in your own list; older versions stay.">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">Kind<select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 font-normal">{DOC_KINDS.map((k) => <option key={k} value={k}>{k.replaceAll("_", " ")}</option>)}</select></label>
          <label className="block text-sm font-medium">Task<select value={taskId} onChange={(e) => setTaskId(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 font-normal">{taskOptions(tasks, "Whole project").map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        </div>
        {isManager && <label className="mt-3 flex items-center gap-3 text-sm"><input type="checkbox" checked={managersOnly} onChange={(e) => setManagersOnly(e.target.checked)} className="h-5 w-5 accent-[rgb(var(--brand))]" />Only project managers can see this</label>}
        <input ref={file} type="file" accept="application/pdf,image/*" disabled={busy === "doc"} aria-label="Choose a document" onChange={(e) => { const f = e.target.files?.[0]; if (f) void run("doc", () => upload(f), "Document added").finally(() => { if (file.current) file.current.value = ""; }); }}
          className="mt-3 block w-full text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-brand file:px-4 file:py-2 file:font-semibold file:text-onbrand" />
      </Card>
      {list.loading && !list.data ? <Skeleton className="h-20" /> : (list.data?.documents.length ?? 0) === 0 ? <EmptyState title="No documents" hint="Specifications, drawings, certificates and manuals live here." /> : (
        <ul className="space-y-2">{list.data?.documents.map((d) => <Row key={d.id} className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate font-medium">{d.name}</p><p className="text-xs text-ink/60">{d.kind.replaceAll("_", " ")} · v{d.version}{d.current ? "" : " · older version"} · {dt(d.createdAt)}</p></div>{d.url && <a href={d.url} target="_blank" rel="noreferrer" className="shrink-0 text-sm font-semibold text-brand underline">Open</a>}</Row>)}</ul>
      )}
    </div>
  );
}

// ── materials and procurement (PRD §63-64) ───────────────────────────────────
type Proc = { id: string; specification: string; quantity: number; status: string; orderId: string | null; quotes: { id: string; merchantName: string; unitPriceMinor: number; currency: string; leadDays: number | null; status: string }[] };
function ProcurementPanel({ projectId, tasks, currency }: Props) {
  const list = useLoad(() => api<{ procurement: Proc[] }>("GET", `/projects/${projectId}/procurement`), [projectId]);
  const { busy, run } = useRun();
  return (
    <div className="space-y-4">
      <Card title="Request materials" hint="Merchants quote. You pick. The purchase is its own order with its own payment, separate from any service payment.">
        <SimpleForm columns={2} submit="Request quotes" fields={[
          { name: "specification", label: "What do you need (be specific)", type: "textarea", required: true, maxLength: 4000 }, { name: "quantity", label: "Quantity", type: "number", defaultValue: "1" },
          { name: "taskId", label: "For task", type: "select", options: taskOptions(tasks, "Whole project") },
        ]} onSubmit={async (v) => { await api("POST", `/projects/${projectId}/procurement`, v); list.reload(); }} />
        <p className="mt-3 text-xs text-ink/60">Know what you want? <Link className="font-semibold underline" to={`/shop?project=${projectId}`}>Browse the shop</Link>.</p>
      </Card>
      {(list.data?.procurement.length ?? 0) === 0 ? <EmptyState title="Nothing requested" hint="Requests and merchant quotes appear here." /> : (
        <ul className="space-y-3">{list.data?.procurement.map((r) => (
          <Row key={r.id}>
            <div className="flex items-start justify-between gap-2"><p className="font-medium">{r.specification} <span className="text-ink/50">× {r.quantity}</span></p><Pill value={r.status} /></div>
            {r.quotes.length > 0 && <ul className="mt-2 space-y-1.5">{r.quotes.map((q) => (
              <li key={q.id} className="flex items-center justify-between gap-2 text-sm"><span>{q.merchantName}{q.leadDays !== null ? <span className="text-ink/50"> · {q.leadDays} day(s)</span> : null}</span>
                <span className="flex items-center gap-2 font-semibold">{formatMoney(q.unitPriceMinor, q.currency)} each{r.status === "quoting" && <Button variant="quiet" busy={busy === q.id} onClick={() => void run(q.id, () => api("POST", `/procurement/${r.id}/select`, { quoteId: q.id }), "Order placed", list.reload)}>Choose</Button>}</span></li>
            ))}</ul>}
            {r.status === "ordered" && <Button className="mt-2" variant="quiet" busy={busy === `a${r.id}`} onClick={() => void run(`a${r.id}`, () => api("POST", `/procurement/${r.id}/accept`, {}), "Accepted", list.reload)}>Mark delivered goods as accepted</Button>}
          </Row>
        ))}</ul>
      )}
      <p className="text-xs text-ink/50">Amounts are in each merchant's own currency. Project currency: {currency}.</p>
    </div>
  );
}

// ── handover (PRD §139-140) ──────────────────────────────────────────────────
type Handover = { items: { key: string; label: string; ok: boolean; blocking: boolean; detail: string | null }[]; canClose: boolean };
function HandoverPanel({ projectId, onChanged }: Props) {
  const h = useLoad(() => api<Handover>("GET", `/projects/${projectId}/handover`), [projectId]);
  const { busy, run } = useRun();
  const [decl, setDecl] = useState("");
  if (h.loading && !h.data) return <Skeleton className="h-40" />;
  if (!h.data) return <Note>{h.error ?? "Not available"}</Note>;
  const openIssues = h.data.items.find((i) => i.key === "no_open_issues" && !i.ok);
  return (
    <div className="space-y-4">
      <Card title="Before you close" hint="Blocking items must be done. The others are strongly recommended.">
        <ul className="space-y-2">{h.data.items.map((i) => <li key={i.key} className="flex items-start gap-2.5 text-sm"><span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${i.ok ? "bg-signal" : i.blocking ? "bg-alarm" : "bg-caution"}`} /><span>{i.label}{i.detail ? <span className="text-ink/50"> · {i.detail}</span> : null}{!i.ok && i.blocking ? <span className="ml-1 text-xs font-bold text-alarm">blocking</span> : null}</span></li>)}</ul>
        {openIssues && <label className="mt-4 block text-sm font-medium">Declare what remains unresolved<textarea value={decl} onChange={(e) => setDecl(e.target.value)} rows={2} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 font-normal" /></label>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="gold" disabled={!h.data.canClose || (!!openIssues && decl.trim().length < 3)} busy={busy === "aftercare"} onClick={() => void run("aftercare", () => api("POST", `/projects/${projectId}/handover`, { outcome: "aftercare", ...(decl.trim() ? { unresolvedIssueDeclaration: decl.trim() } : {}) }), "Project handed over", () => { h.reload(); onChanged(); })}>Hand over (keep warranty and aftercare)</Button>
          <Button variant="quiet" disabled={!h.data.canClose || (!!openIssues && decl.trim().length < 3)} busy={busy === "completed"} onClick={() => void run("completed", () => api("POST", `/projects/${projectId}/handover`, { outcome: "completed", ...(decl.trim() ? { unresolvedIssueDeclaration: decl.trim() } : {}) }), "Project completed", () => { h.reload(); onChanged(); })}>Close as completed</Button>
        </div>
      </Card>
      <Card title="After the work" hint="Register what was installed so warranties and maintenance reminders follow it.">
        <div className="flex flex-wrap gap-2"><Link to={`/assets?project=${projectId}`} className="rounded-xl border border-brand px-3 py-2 text-sm font-semibold text-brand hover:bg-brand/5">Register an asset</Link><Link to="/assets" className="rounded-xl border border-line px-3 py-2 text-sm font-semibold hover:bg-brand/5">Record a warranty</Link></div>
      </Card>
    </div>
  );
}

