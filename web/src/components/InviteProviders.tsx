import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { CATEGORIES } from "../lib/taxonomy";
import { useToast } from "../lib/toast";
import type { ProviderRow } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { Avatar } from "./ProviderCard";
import { EmptyState, Note, Skeleton } from "./ui";

const TRADES = CATEGORIES.filter((c) => c.seeded);

/** The missing step: a project manager picks providers and invites them to quote on one task. */
export function InviteProviders({ taskId, taskTitle, onInvited }: { taskId: string; taskTitle: string; onInvited: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState<string>("");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setTerm(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  const people = useLoad(() => {
    const p = new URLSearchParams();
    if (category) p.set("category", category);
    if (term) p.set("q", term);
    return api<{ providers: ProviderRow[] }>("GET", `/providers?${p.toString()}`);
  }, [category, term]);
  const list = people.data?.providers ?? [];

  async function invite(p: ProviderRow) {
    setBusy(p.id);
    try {
      await api("POST", `/tasks/${taskId}/invitations`, { providerProfileId: p.id });
      setInvited((s) => new Set(s).add(p.id));
      sessionStorage.removeItem("lp_pref_provider");
      toast.success(`${p.displayName} was invited to quote`);
      onInvited();
    } catch (e) {
      if (e instanceof ApiError && e.code === "invitation_exists") setInvited((s) => new Set(s).add(p.id));
      else toast.error(e instanceof Error ? e.message : "Could not invite");
    } finally {
      setBusy(null);
    }
  }

  // The provider the person tapped on Find before posting the request (kept for one hour, used once).
  const [pref, setPref] = useState<{ id: string; name: string } | null>(() => {
    try {
      const v = JSON.parse(sessionStorage.getItem("lp_pref_provider") ?? "null") as { id: string; name: string; at: number } | null;
      return v && Date.now() - v.at < 3_600_000 ? { id: v.id, name: v.name } : null;
    } catch { return null; }
  });
  const prefPending = pref !== null && !invited.has(pref.id);

  return (
    <div className="mt-4 space-y-3">
      {pref && prefPending && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-gold/60 bg-gold/10 p-3 text-sm">
          <p>You picked <span className="font-semibold">{pref.name}</span> on Find.</p>
          <div className="flex shrink-0 gap-2">
            <button type="button" disabled={busy !== null} onClick={() => void invite({ id: pref.id, displayName: pref.name, headline: null, kind: "individual", remoteOk: false })}
              className="rounded-xl bg-gold px-3 py-1.5 font-semibold text-ink disabled:opacity-60">Invite</button>
            <button type="button" onClick={() => { sessionStorage.removeItem("lp_pref_provider"); setPref(null); }} className="rounded-xl border border-line px-3 py-1.5 font-semibold">Not now</button>
          </div>
        </div>
      )}
      <p className="text-sm text-ink/70">Invite people to quote on <span className="font-semibold">{taskTitle}</span>. They see this task only, not your whole project.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setCategory("")} aria-pressed={category === ""}
          className={`rounded-full border px-3 py-1 text-sm font-semibold ${category === "" ? "border-brand bg-brand text-onbrand" : "border-line"}`}>All</button>
        {TRADES.map((c) => (
          <button key={c.key} type="button" onClick={() => setCategory(c.key)} aria-pressed={category === c.key}
            className={`rounded-full border px-3 py-1 text-sm font-semibold ${category === c.key ? "border-brand bg-brand text-onbrand" : "border-line"}`}>{c.name}</button>
        ))}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or headline" aria-label="Search providers"
        className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base focus:border-brand" />
      {people.error && <Note>{people.error}</Note>}
      {people.loading && !people.data ? <Skeleton className="h-20" /> : list.length === 0 ? (
        <EmptyState title="No providers found" hint="Providers appear here once they create a profile and pick the trades they do." />
      ) : (
        <ul className="space-y-2">
          {list.map((p) => {
            const done = invited.has(p.id);
            return (
              <li key={p.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
                <Avatar name={p.displayName} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold leading-tight">{p.displayName}</p>
                  <p className="line-clamp-1 text-sm text-ink/60">{p.headline ?? "No headline yet."}</p>
                </div>
                <button type="button" disabled={done || busy !== null} onClick={() => void invite(p)}
                  className="shrink-0 rounded-xl border border-brand px-3 py-2 text-sm font-semibold text-brand transition enabled:hover:bg-brand/5 disabled:opacity-60">
                  {done ? "Invited" : busy === p.id ? "Inviting..." : "Invite to quote"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
