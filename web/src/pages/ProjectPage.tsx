import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChangesPanel } from "../components/ChangesPanel";
import { InviteProviders } from "../components/InviteProviders";
import { JourneyBar } from "../components/JourneyBar";
import { ManagerQuotes } from "../components/ManagerQuotes";
import { MilestonesPanel } from "../components/MilestonesPanel";
import { ProjectExtras } from "../components/ProjectExtras";
import { ReviewPanel } from "../components/ReviewPanel";
import { Tape } from "../components/Tape";
import { Timeline } from "../components/Timeline";
import { Health, Note, Pill, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { providerNext, ownerNext, type Action, type Tab } from "../lib/journey";
import { TASK_LABEL, label } from "../lib/labels";
import { progressFromTasks } from "../lib/progress";
import { useToast } from "../lib/toast";
import type { Milestone, PaymentView, ProjectDetail } from "../lib/types";
import { useLoad } from "../lib/useLoad";

const MANAGER_ROLES = ["project_owner", "project_manager"];
const DONE = ["approved", "completed"];
const ACTIVE = ["in_progress", "submitted", "assigned", "accepted", "offered", "ready"];
const WORKABLE = ["accepted", "in_progress", "submitted", "approved", "completed"];

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "money", label: "Stages and payment" },
  { key: "changes", label: "Changes" },
  { key: "activity", label: "Activity" },
  { key: "more", label: "More" },
];

export default function ProjectPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: Tab = TABS.some((t) => t.key === requested) ? (requested as Tab) : "overview";

  const detail = useLoad(() => api<ProjectDetail>("GET", `/projects/${id}`), [id]);
  const roles = detail.data?.roles ?? [];
  const isManager = roles.some((r) => MANAGER_ROLES.includes(r));
  const providerOnly = roles.length > 0 && roles.every((r) => r === "provider" || r === "provider_team_member");

  const [bump, setBump] = useState(0);
  const milestones = useLoad(
    () => api<{ milestones: Milestone[] }>("GET", `/projects/${id}/milestones`).catch(() => ({ milestones: [] as Milestone[] })),
    [id, bump],
  );
  const payments = useLoad(
    () => (isManager ? api<{ payments: PaymentView[] }>("GET", `/projects/${id}/payments`).catch(() => ({ payments: [] as PaymentView[] })) : Promise.resolve({ payments: [] as PaymentView[] })),
    [id, isManager, bump],
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refreshAll() {
    detail.reload();
    setBump((n) => n + 1);
  }

  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });

  async function markReady(taskId: string) {
    setBusy(taskId);
    setError(null);
    try {
      await api("POST", `/tasks/${taskId}/transition`, { to: "ready" });
      toast.success("Task is open for quotes");
      refreshAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not update the task";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  }

  function act(a: Action) {
    if (a.kind === "markReady") { void markReady(a.taskId); return; }
    if (a.kind === "link") { nav(a.to); return; }
    setTab(a.tab);
    window.setTimeout(() => document.getElementById(a.tab === "overview" ? "invite" : "tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }

  if (detail.loading && !detail.data) {
    return <div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-24" /></div>;
  }
  if (detail.error || !detail.data) {
    return (
      <div className="space-y-3">
        <Note>{detail.error ?? "Project not found"}</Note>
        <Link to="/projects" className="text-sm font-semibold text-brand underline">Back to projects</Link>
      </div>
    );
  }

  const { project, stages, tasks } = detail.data;
  const prog = progressFromTasks(tasks);
  const inviteTask = tasks.find((t) => t.status === "ready" || t.status === "offered");
  const ms = milestones.data?.milestones ?? [];
  const pays = payments.data?.payments ?? [];
  const next = isManager ? ownerNext(project.id, tasks, ms, pays) : providerNext(project.id, tasks, ms);

  return (
    <div className="space-y-6">
      <Link to="/projects" className="text-sm font-semibold text-brand underline">All projects</Link>

      <header className="adire rounded-3xl p-6 text-white md:p-8">
        <h1 className="text-3xl font-bold leading-tight">{project.title}</h1>
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-white/80">
          <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold">{project.status.replaceAll("_", " ")}</span>
          <span>{project.currency}</span>
          <span aria-hidden>·</span>
          <span>{project.timezone}</span>
        </p>
        {project.objective && <p className="mt-4 max-w-prose text-white/85">{project.objective}</p>}
        <div className="mt-6"><Tape value={prog.value} tone="dark" label="Project progress" /></div>
        <p className="mt-3 text-sm text-white/70"><Health value={project.health} /></p>
      </header>

      {error && <Note>{error}</Note>}

      <JourneyBar next={next} busy={busy !== null} onAction={act} />

      <div id="tabs" role="tablist" aria-label="Project sections" className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
        {TABS.map((t) => (
          <button
            key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition active:scale-95 ${tab === t.key ? "bg-brand text-onbrand" : "border border-line bg-surface text-ink/70 hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="page-in space-y-8">
          {isManager && inviteTask && (
            <section id="invite" className="rounded-2xl border border-line bg-surface p-5">
              <h2 className="text-lg font-semibold">Invite providers to quote</h2>
              <InviteProviders key={inviteTask.id} taskId={inviteTask.id} taskTitle={inviteTask.title} onInvited={() => { setBump((n) => n + 1); detail.reload(); }} />
              <ManagerQuotes taskId={inviteTask.id} refreshKey={bump} onChanged={refreshAll} />
            </section>
          )}

          <section>
            <h2 className="text-xl font-semibold">Work to be done</h2>
            {stages.length > 1 && <p className="mt-1 text-sm text-ink/60">{stages.map((s) => s.name).join(", ")}</p>}
            {tasks.length === 0 ? (
              <p className="mt-3 text-ink/60">No tasks yet.</p>
            ) : (
              <ol className="relative mt-4 space-y-4 border-l-2 border-line pl-6">
                {tasks.map((t) => {
                  const node = DONE.includes(t.status) ? "bg-signal" : ACTIVE.includes(t.status) ? "bg-gold" : "bg-line";
                  return (
                    <li key={t.id} className="relative rounded-2xl border border-line bg-surface p-4">
                      <span aria-hidden className={`absolute -left-[34px] top-5 h-3.5 w-3.5 rounded-full border-2 border-paper ${node}`} />
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="font-semibold">{t.title}</p>
                          {t.description && t.description !== t.title && <p className="mt-1 line-clamp-2 text-sm text-ink/70">{t.description}</p>}
                          <p className="mt-2"><Pill value={t.status} label={label(TASK_LABEL, t.status)} /></p>
                        </div>
                        {WORKABLE.includes(t.status) && (
                          <Link to={`/projects/${project.id}/tasks/${t.id}`} className="shrink-0 rounded-xl border border-brand px-3 py-2 text-center text-sm font-semibold text-brand hover:bg-brand/5">
                            {isManager ? (t.status === "submitted" ? "Review work" : "Open") : t.status === "accepted" ? "Start" : "Open work"}
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      )}

      {tab === "money" && (
        <div className="page-in">
          {tasks.length > 0 ? (
            <MilestonesPanel projectId={project.id} currency={project.currency} isManager={isManager} onChanged={refreshAll} />
          ) : (
            <p className="text-ink/60">Stages and payment appear once the project has a task.</p>
          )}
        </div>
      )}

      {tab === "changes" && (
        <div className="page-in">
          {tasks.length > 0 ? <ChangesPanel projectId={project.id} currency={project.currency} tasks={tasks} onApplied={refreshAll} /> : <p className="text-ink/60">Changes can be proposed once the project has a task.</p>}
        </div>
      )}

      {tab === "activity" && <div className="page-in"><Timeline projectId={project.id} /></div>}

      {tab === "more" && (
        <div className="page-in space-y-8">
          <ProjectExtras projectId={project.id} currency={project.currency} isManager={isManager} providerOnly={providerOnly} tasks={tasks} stages={stages} onChanged={refreshAll} />
          {isManager && <ReviewPanel projectId={project.id} />}
        </div>
      )}
    </div>
  );
}
