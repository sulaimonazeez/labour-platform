import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Assistant } from "../components/Assistant";
import { HowItWorks } from "../components/HowItWorks";
import { WorkLane } from "../components/WorkLane";
import { CompassIcon, LayersIcon, UserIcon } from "../components/Icons";
import { ProjectCard } from "../components/ProjectCard";
import { Button, EmptyState, Note, Pill, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type { Market, ProjectRow, RequestRow } from "../lib/types";
import { useLoad } from "../lib/useLoad";

export default function Home() {
  const { user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const location = useLocation();
  const prefill = (location.state as { prefill?: string } | null)?.prefill;
  const requests = useLoad(() => api<{ requests: RequestRow[] }>("GET", "/requests"));
  const projects = useLoad(() => api<{ projects: ProjectRow[] }>("GET", "/projects"));
  const reference = useLoad(() => api<{ markets: Market[] }>("GET", "/reference"));

  const [currency, setCurrency] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const markets = reference.data?.markets ?? [];
  const market = markets.find((m) => m.id === user?.marketId) ?? markets[0];
  const chosenCurrency = currency ?? market?.defaultCurrency ?? "";

  async function start(r: RequestRow) {
    setBusy(r.id);
    setError(null);
    try {
      const res = await api<{ project: { id: string } }>("POST", `/requests/${r.id}/convert`, { currency: chosenCurrency });
      toast.success("Project started");
      nav(`/projects/${res.project.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not start the project";
      setError(msg);
      toast.error(msg);
      setBusy(null);
    }
  }

  const open = (requests.data?.requests ?? []).filter((r) => r.status !== "converted");
  const recent = (projects.data?.projects ?? []).slice(0, 4);

  const tile = "group flex items-center gap-3 rounded-2xl border border-line bg-surface p-3.5 transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lg hover:shadow-brand/10 active:scale-[0.98]";
  const tileIcon = "grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand transition group-hover:bg-brand group-hover:text-onbrand";

  return (
    <div className="space-y-8">
      <Assistant currency={chosenCurrency} prefill={prefill} onPosted={requests.reload} />

      <HowItWorks />

      <nav aria-label="Ways to start" className="grid gap-3 sm:grid-cols-3">
        <Link to="/find" className={tile}>
          <span className={tileIcon}><CompassIcon /></span>
          <span><span className="block font-semibold leading-tight">Find a service</span><span className="text-xs text-ink/60">Browse trades and people</span></span>
        </Link>
        <Link to="/projects" className={tile}>
          <span className={tileIcon}><LayersIcon /></span>
          <span><span className="block font-semibold leading-tight">My work</span><span className="text-xs text-ink/60">Projects and progress</span></span>
        </Link>
        <Link to="/profile" className={tile}>
          <span className={tileIcon}><UserIcon /></span>
          <span><span className="block font-semibold leading-tight">My profile</span><span className="text-xs text-ink/60">Account and provider tools</span></span>
        </Link>
      </nav>

      <WorkLane />

      {error && <Note>{error}</Note>}

      {(requests.loading || open.length > 0) && (
        <section>
          <h2 className="text-xl font-semibold">Requests you have posted</h2>
          <p className="mt-1 text-sm text-ink/60">Start a project from a request to invite providers and get quotes.</p>
          {requests.error && <div className="mt-3"><Note>{requests.error}</Note></div>}
          {requests.loading && !requests.data ? (
            <Skeleton className="mt-3 h-20" />
          ) : (
            <ul className="mt-3 space-y-3">
              {open.map((r) => (
                <li key={r.id} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="line-clamp-2 font-medium">{r.rawText ?? "(no description)"}</p>
                    <p className="mt-1 flex items-center gap-2 text-xs text-ink/60">{new Date(r.createdAt).toLocaleDateString()} <Pill value={r.status} /></p>
                  </div>
                  <div className="flex items-center gap-2">
                    {market && market.currencies.length > 1 && (
                      <select aria-label="Currency" value={chosenCurrency} onChange={(e) => setCurrency(e.target.value)} className="rounded-xl border border-line bg-surface px-2 py-2 text-sm">
                        {market.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    )}
                    <Button onClick={() => start(r)} busy={busy === r.id} disabled={busy !== null || !chosenCurrency}>Start project</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">Your projects</h2>
          {(projects.data?.projects.length ?? 0) > 4 && <Link to="/projects" className="text-sm font-semibold text-brand underline">See all</Link>}
        </div>
        {projects.error && <div className="mt-3"><Note>{projects.error}</Note></div>}
        {projects.loading && !projects.data ? (
          <div className="mt-3 space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        ) : recent.length === 0 ? (
          <div className="mt-3"><EmptyState title="No projects yet" hint="Describe a job above, then start a project from it." /></div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">{recent.map((p) => <ProjectCard key={p.id} p={p} />)}</div>
        )}
      </section>
    </div>
  );
}
