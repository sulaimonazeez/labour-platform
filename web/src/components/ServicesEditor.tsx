import { useState } from "react";
import { api } from "../lib/api";
import { CATEGORIES } from "../lib/taxonomy";
import { useToast } from "../lib/toast";
import { useLoad } from "../lib/useLoad";
import { Button, Note } from "./ui";

// Only categories that exist in the database seed can be saved; the others are shown on Find but not offered here yet.
const OFFERABLE = CATEGORIES.filter((c) => c.seeded);

export function TradePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div role="group" aria-label="Services you offer" className="flex flex-wrap gap-2">
      {OFFERABLE.map((c) => {
        const on = value.includes(c.key);
        return (
          <button key={c.key} type="button" aria-pressed={on}
            onClick={() => onChange(on ? value.filter((k) => k !== c.key) : [...value, c.key])}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition active:scale-95 ${on ? "border-brand bg-brand text-onbrand" : "border-line bg-surface"}`}>
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

/** Lets an existing provider choose the trades they are listed under. Without this nobody can find them by trade. */
export function ServicesEditor() {
  const toast = useToast();
  const saved = useLoad(() => api<{ categories: string[] }>("GET", "/providers/me/services"));
  const [draft, setDraft] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = draft ?? saved.data?.categories ?? [];
  const dirty = draft !== null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/providers/me/services", { categories: current });
      toast.success("Your services are saved");
      setDraft(null);
      saved.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h3 className="font-semibold">What you do</h3>
      <p className="mt-1 text-sm text-ink/60">People searching for these trades will find you.</p>
      <div className="mt-3"><TradePicker value={current} onChange={setDraft} /></div>
      {current.length === 0 && !dirty && <p className="mt-2 text-sm text-caution">You are not listed under any trade yet, so trade searches will not show you.</p>}
      {error && <div className="mt-2"><Note>{error}</Note></div>}
      {dirty && <Button className="mt-3" busy={busy} onClick={() => void save()}>Save services</Button>}
    </div>
  );
}
