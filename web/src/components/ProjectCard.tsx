import { Link } from "react-router-dom";
import { progressFromCounts } from "../lib/progress";
import type { ProjectRow } from "../lib/types";
import { Health, Pill } from "./ui";
import { Tape } from "./Tape";

export function ProjectCard({ p, fresh = false }: { p: ProjectRow; fresh?: boolean }) {
  const prog = progressFromCounts(p.taskStatuses ?? {});
  return (
    <Link
      to={`/projects/${p.id}`}
      className={`block rounded-2xl border border-line bg-surface p-4 transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-brand/10 ${fresh ? "rise" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold leading-snug">{p.title}</h3>
        <Pill value={p.status} />
      </div>
      <div className="mt-3"><Tape value={prog.value} compact label={`${p.title} progress`} /></div>
      <p className="mt-2 flex items-center justify-between text-xs text-ink/60">
        <span>{prog.label}</span>
        <Health value={p.health} />
      </p>
    </Link>
  );
}
