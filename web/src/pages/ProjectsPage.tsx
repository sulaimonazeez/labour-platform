import { useState } from "react";
import { ProjectCard } from "../components/ProjectCard";
import { EmptyState, Note, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { progressFromCounts } from "../lib/progress";
import type { ProjectRow } from "../lib/types";
import { useLoad } from "../lib/useLoad";

type Filter = "all" | "active" | "done";

export default function ProjectsPage() {
  const projects = useLoad(() => api<{ projects: ProjectRow[] }>("GET", "/projects"));
  const [filter, setFilter] = useState<Filter>("all");

  const all = projects.data?.projects ?? [];
  const isDone = (p: ProjectRow) => progressFromCounts(p.taskStatuses ?? {}).stage === 4;
  const shown = all.filter((p) => (filter === "all" ? true : filter === "done" ? isDone(p) : !isDone(p)));
  const count = (f: Filter) => all.filter((p) => (f === "all" ? true : f === "done" ? isDone(p) : !isDone(p))).length;

  const chip = (f: Filter, label: string) => (
    <button
      key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
      className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition ${filter === f ? "bg-brand text-onbrand" : "border border-line bg-surface text-ink/70 hover:text-ink"}`}
    >
      {label} <span className="opacity-70">{count(f)}</span>
    </button>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Projects</h1>
      <div className="flex flex-wrap gap-2">{chip("all", "All")}{chip("active", "In progress")}{chip("done", "Done")}</div>
      {projects.error && <Note>{projects.error}</Note>}
      {projects.loading && !projects.data ? (
        <div className="grid gap-3 sm:grid-cols-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      ) : shown.length === 0 ? (
        <EmptyState title="Nothing here" hint={filter === "all" ? "Start a project from the home screen." : "No projects match this filter yet."} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">{shown.map((p) => <ProjectCard key={p.id} p={p} />)}</div>
      )}
    </div>
  );
}
