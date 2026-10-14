import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { useToast } from "../lib/toast";
import { Button, Note } from "./ui";

// Small, boring building blocks so every blueprint screen stays short and looks the same.

export function Card({ title, hint, action, children, className = "" }: { title?: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-lg font-semibold leading-tight">{title}</h2>}
            {hint && <p className="mt-0.5 text-sm text-ink/60">{hint}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; badge?: number }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {tabs.map((t) => (
        <button
          key={t.id} role="tab" type="button" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold transition active:scale-95 ${value === t.id ? "bg-brand text-onbrand" : "border border-line bg-surface text-ink/70 hover:text-ink"}`}
        >
          {t.label}{t.badge ? <span className="ml-1.5 rounded-full bg-gold px-1.5 text-[11px] font-bold text-[#2B1E00]">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong");

/** Runs an async action with one busy flag and a toast. Buttons built on it cannot double-fire. */
export function useRun() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (id: string, fn: () => Promise<unknown>, ok?: string, after?: () => void) => {
    setBusy(id);
    try { await fn(); if (ok) toast.success(ok); after?.(); }
    catch (e) { toast.error(errText(e)); }
    finally { setBusy(null); }
  }, [toast]);
  return { busy, run };
}

export const dt = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");
export const day = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleDateString([], { dateStyle: "medium" }) : "");
export const isoFromLocal = (v: string) => new Date(v).toISOString();

export type FieldDef = {
  name: string; label: string; type?: "text" | "number" | "date" | "datetime" | "select" | "textarea" | "checkbox" | "email";
  options?: { value: string; label: string }[]; placeholder?: string; required?: boolean; defaultValue?: string | boolean; hint?: string; maxLength?: number;
};

/** Builds a form from a list of fields. Empty fields are left out of what is submitted. Dates become ISO strings. */
export function SimpleForm({ fields, submit, onSubmit, columns = 1, secondary }: {
  fields: FieldDef[]; submit: string; onSubmit: (values: Record<string, any>) => Promise<unknown>; columns?: 1 | 2; secondary?: ReactNode;
}) {
  const initial = Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? (f.type === "checkbox" ? false : f.type === "select" ? (f.options?.[0]?.value ?? "") : "")]));
  const [v, setV] = useState<Record<string, string | boolean>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out: Record<string, any> = {};
      for (const f of fields) {
        const raw = v[f.name];
        if (f.type === "checkbox") { out[f.name] = Boolean(raw); continue; }
        const s = String(raw ?? "").trim();
        if (s === "") continue;
        out[f.name] = f.type === "number" ? Number(s) : f.type === "datetime" ? isoFromLocal(s) : s;
      }
      await onSubmit(out);
      setV(initial);
    } catch (err) {
      const m = errText(err);
      setError(m);
      toast.error(m);
    } finally { setBusy(false); }
  }

  const input = "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base focus:border-brand";
  return (
    <form onSubmit={go} className="space-y-3">
      <div className={columns === 2 ? "grid gap-3 sm:grid-cols-2" : "space-y-3"}>
        {fields.map((f) => (
          <label key={f.name} className={`block ${f.type === "textarea" ? "sm:col-span-2" : ""}`}>
            {f.type === "checkbox" ? (
              <span className="flex items-center gap-3 text-sm">
                <input type="checkbox" checked={Boolean(v[f.name])} onChange={(e) => setV({ ...v, [f.name]: e.target.checked })} className="h-5 w-5 accent-[rgb(var(--brand))]" />
                {f.label}
              </span>
            ) : (
              <>
                <span className="mb-1 block text-sm font-medium">{f.label}{f.required ? " *" : ""}</span>
                {f.type === "select" ? (
                  <select className={input} value={String(v[f.name])} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}>
                    {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.type === "textarea" ? (
                  <textarea className={input} rows={3} maxLength={f.maxLength} placeholder={f.placeholder} required={f.required} value={String(v[f.name])} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
                ) : (
                  <input
                    className={input} required={f.required} maxLength={f.maxLength} placeholder={f.placeholder}
                    type={f.type === "datetime" ? "datetime-local" : f.type === "number" ? "number" : f.type ?? "text"} step={f.type === "number" ? "any" : undefined}
                    value={String(v[f.name])} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}
                  />
                )}
              </>
            )}
            {f.hint && <span className="mt-1 block text-xs text-ink/50">{f.hint}</span>}
          </label>
        ))}
      </div>
      {error && <Note>{error}</Note>}
      <div className="flex items-center gap-2"><Button type="submit" busy={busy}>{submit}</Button>{secondary}</div>
    </form>
  );
}

export function Row({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <li className={`rounded-xl border border-line p-3 ${className}`}>{children}</li>;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return <div className="rounded-xl bg-brand/5 p-3 text-center"><p className="text-2xl font-bold tabular-nums">{value}</p><p className="text-xs text-ink/60">{label}</p></div>;
}

/** Labels from PRD §107: what the reader may trust about a piece of content. */
export function TrustBadge({ source, labels }: { source?: string; labels?: string[] }) {
  const all = [...(labels ?? []), ...(source ? [source] : [])];
  const map: Record<string, [string, string]> = {
    ai_generated: ["AI generated", "bg-gold/25 text-caution"], ai: ["AI suggested", "bg-gold/25 text-caution"], rules_generated: ["Built from rules", "bg-brand/10 text-brand"],
    from_template: ["From a template", "bg-brand/10 text-brand"], professionally_verified: ["Professionally verified", "bg-signal/15 text-signal"], record: ["From the record", "bg-brand/10 text-brand"],
  };
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {all.filter((l) => map[l]).map((l) => <span key={l} className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${map[l][1]}`}>{map[l][0]}</span>)}
    </span>
  );
}
