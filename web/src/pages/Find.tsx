import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CategoryIcon, SearchIcon, SparkIcon, WarnIcon } from "../components/Icons";
import { Avatar } from "../components/ProviderCard";
import { Button, EmptyState, Note, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { useTypeLines } from "../lib/motion";
import { CATEGORIES, EMERGENCY_NOTE, EXAMPLES, PATH_INFO, RISK_NOTE, understand } from "../lib/taxonomy";
import { useLoad } from "../lib/useLoad";

type Ranked = { providerId: string; displayName: string; headline: string | null; kind: string; remoteOk: boolean; score: number; sponsored: boolean; distanceKm: number | null; reasons: string[] };

function RankedCard({ p, onPick }: { p: Ranked; onPick?: () => void }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3.5">
      <div className="flex items-center gap-3">
        <Avatar name={p.displayName} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{p.displayName}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded-full bg-brand/10 px-2 py-0.5 font-semibold text-brand">{p.kind === "company" ? "Company" : "Individual"}</span>
            {p.remoteOk && <span className="rounded-full bg-signal/15 px-2 py-0.5 font-semibold text-signal">Remote OK</span>}
            {p.sponsored && <span className="rounded-full bg-gold/30 px-2 py-0.5 font-bold text-caution">Sponsored</span>}
            {p.distanceKm !== null && <span className="text-ink/60">{p.distanceKm} km</span>}
          </p>
        </div>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gold/25 text-sm font-bold" title="Fit score out of 100">{p.score}</span>
      </div>
      {p.headline && <p className="mt-2 line-clamp-2 text-sm text-ink/70">{p.headline}</p>}
      <details className="mt-2 text-xs text-ink/70"><summary className="cursor-pointer font-semibold text-brand">Why this match</summary><ul className="mt-1.5 list-disc space-y-0.5 pl-4">{p.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></details>
      {onPick && <button type="button" onClick={onPick} className="mt-3 w-full rounded-xl border border-line px-3 py-2 text-sm font-semibold transition hover:bg-brand/5 active:scale-[0.98]">Post a request, then invite them</button>}
    </div>
  );
}

export default function Find() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [focused, setFocused] = useState(false);
  const [term, setTerm] = useState("");

  const u = useMemo(() => understand(query), [query]);
  const hasQuery = query.trim().length > 0;
  const typed = useTypeLines(EXAMPLES, !hasQuery && !focused).text;

  // Which word do we look people up by? A clear trade wins; otherwise treat the text as a name or headline.
  const sure = u.top && u.matches[0].score >= 2 ? u.top : null;
  const wanted = sure ? (sure.seeded ? `category:${sure.key}` : sure.search) : query.trim().length >= 2 ? query.trim().slice(0, 80) : "";
  useEffect(() => {
    const id = window.setTimeout(() => setTerm(wanted), 250);
    return () => window.clearTimeout(id);
  }, [wanted]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (query.trim()) next.set("q", query.trim()); else next.delete("q");
      setParams(next, { replace: true });
    }, 400);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const params2 = new URLSearchParams();
  if (u.top && u.matches[0].score >= 2) params2.set("category", u.top.key);
  else if (term) params2.set("q", term);
  const people = useLoad(() => api<{ sponsored: Ranked[]; results: Ranked[]; excluded: { count: number; reasons: Record<string, number> } }>("GET", `/discover/providers?${params2.toString()}`).catch(async (e: unknown) => {
    // A service key the server does not know yet (taxonomy not seeded) must not leave people with an empty page.
    if (e instanceof Error && /unknown_category|does not exist/i.test(e.message) && term) return api<{ sponsored: Ranked[]; results: Ranked[]; excluded: { count: number; reasons: Record<string, number> } }>("GET", `/discover/providers?q=${encodeURIComponent(term)}`);
    throw e;
  }), [params2.toString()]);
  const list: Ranked[] = [...(people.data?.sponsored ?? []), ...(people.data?.results ?? [])];

  function post(text: string, who?: { id: string; displayName: string }) {
    if (who) sessionStorage.setItem("lp_pref_provider", JSON.stringify({ id: who.id, name: who.displayName, at: Date.now() }));
    nav("/", { state: { prefill: text } });
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Find help</h1>
        <p className="mt-1 text-ink/70">Search by trade, or just describe the problem.</p>
      </header>

      <div className={`flex items-center gap-2 rounded-2xl border bg-surface px-3 shadow-sm transition ${focused ? "border-brand ring-2 ring-brand/20" : "border-line"}`}>
        <SearchIcon className="h-5 w-5 shrink-0 text-ink/50" />
        <input
          value={query} onChange={(e) => setQuery(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          type="search" enterKeyHint="search" maxLength={200} aria-label="Search for a service or describe a problem"
          placeholder={typed ? `${typed}|` : "Plumber, electrician, my door won't lock"}
          className="w-full bg-transparent py-3.5 text-base placeholder:text-ink/40 focus:outline-none"
        />
        {hasQuery && <button type="button" onClick={() => setQuery("")} className="rounded-full px-2 py-1 text-xs font-semibold text-ink/60 hover:text-ink">Clear</button>}
      </div>

      {!hasQuery && (
        <>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" onClick={() => setQuery(ex)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm transition hover:border-brand/50 hover:bg-brand/5 active:scale-95">{ex}</button>
            ))}
          </div>

          <section>
            <h2 className="text-lg font-semibold">Browse services</h2>
            <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {CATEGORIES.map((c, i) => (
                <li key={c.key} className="rise" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                  <button type="button" onClick={() => setQuery(c.name)} className="group h-full w-full rounded-2xl border border-line bg-surface p-3.5 text-left transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lg hover:shadow-brand/10 active:scale-[0.98]">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand transition group-hover:bg-brand group-hover:text-onbrand"><CategoryIcon id={c.icon} /></span>
                    <span className="mt-2.5 block font-semibold leading-tight">{c.name}</span>
                    <span className="mt-1 line-clamp-2 block text-xs text-ink/60">{c.blurb}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {hasQuery && (
        <section className="rise space-y-3 rounded-2xl border border-line bg-surface p-4" aria-live="polite">
          {u.emergency && (
            <div role="alert" className="flex gap-2.5 rounded-xl border border-alarm/50 bg-alarm/10 p-3 text-sm text-alarm">
              <WarnIcon className="mt-0.5 h-5 w-5 shrink-0" />
              <p><span className="font-semibold">Possible {u.emergency.kind}. </span>{EMERGENCY_NOTE}</p>
            </div>
          )}
          {u.top ? (
            <>
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink/50"><SparkIcon className="h-3.5 w-3.5 text-gold" /> Looks like</p>
              <div className="flex items-center gap-3">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand pop-in"><CategoryIcon id={u.top.icon} className="h-6 w-6" /></span>
                <div className="min-w-0">
                  <p className="text-lg font-semibold leading-tight">{u.top.name}</p>
                  <p className="text-sm text-ink/60">{PATH_INFO[u.path].label}</p>
                </div>
              </div>
              {u.matches.length > 1 && (
                <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink/60">
                  Or:
                  {u.matches.slice(1).map((x) => (
                    <button key={x.category.key} type="button" onClick={() => setQuery(x.category.name)} className="rounded-full border border-line px-2.5 py-0.5 text-xs font-semibold transition hover:bg-brand/5">{x.category.name}</button>
                  ))}
                </p>
              )}
              {RISK_NOTE[u.top.risk] && <p className="text-xs text-caution">{RISK_NOTE[u.top.risk]}</p>}
            </>
          ) : (
            <p className="text-sm text-ink/70">I could not match that to a trade, so I am searching people by name and headline. You can also post it as a request and add detail there.</p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="gold" onClick={() => post(query.trim())}>Post this as a request</Button>
          </div>
        </section>
      )}

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">{hasQuery ? "People who match" : "People on the platform"}</h2>
          {!people.loading && <span className="text-sm text-ink/60">{list.length}</span>}
        </div>
        {people.error && <div className="mt-3"><Note>{people.error}</Note></div>}
        {people.loading && !people.data ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
        ) : list.length === 0 ? (
          <div className="mt-3"><EmptyState title="No one listed here yet" hint={hasQuery ? "Post a request and people can be invited to quote." : "Providers appear here once they create a profile."} /></div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {list.map((p) => <RankedCard key={p.providerId} p={p} onPick={hasQuery ? () => post(query.trim(), { id: p.providerId, displayName: p.displayName }) : undefined} />)}
          </div>
        )}
        <p className="mt-3 text-xs text-ink/50">Ranked by fit, distance, track record, verification and language. New providers get a fair start, and sponsored results are always labelled.</p>
      </section>
    </div>
  );
}
