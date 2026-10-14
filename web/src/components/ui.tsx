import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Spinner() {
  return <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "gold" | "quiet"; busy?: boolean };

export function Button({ variant = "primary", busy = false, className = "", children, disabled, ...p }: BtnProps) {
  const base = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";
  const look =
    variant === "primary" ? "bg-brand text-onbrand hover:opacity-90"
    : variant === "gold" ? "bg-gold text-[#2B1E00] hover:brightness-105"
    : "border border-line bg-surface text-ink hover:bg-brand/5";
  return (
    <button className={`${base} ${look} ${className}`} disabled={disabled || busy} {...p}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Field({ label, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <input className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base focus:border-brand" {...p} />
    </label>
  );
}

const DONE = ["completed", "approved", "released", "paid", "secured", "accepted"];
const WARN = ["blocked", "disputed", "cancelled", "rejected", "failed", "delayed"];

export function Pill({ value, label }: { value: string; label?: string }) {
  const tone = DONE.includes(value) ? "bg-signal/15 text-signal" : WARN.includes(value) ? "bg-alarm/15 text-alarm" : "bg-brand/10 text-brand";
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{label ?? value.replaceAll("_", " ")}</span>;
}

export function Health({ value }: { value: string }) {
  const dot = value === "on_track" ? "bg-signal" : ["delayed", "blocked", "disputed"].includes(value) ? "bg-alarm" : "bg-caution";
  const text = value === "on_track" ? "on track" : value.replaceAll("_", " ");
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {text.charAt(0).toUpperCase() + text.slice(1)}
    </span>
  );
}

export function Note({ tone = "error", children }: { tone?: "error" | "info"; children: ReactNode }) {
  const look = tone === "error" ? "border-alarm/40 bg-alarm/10 text-alarm" : "border-line bg-surface text-ink/70";
  return <p role={tone === "error" ? "alert" : undefined} className={`rounded-xl border px-3 py-2 text-sm ${look}`}>{children}</p>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton rounded-lg ${className}`} />;
}

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center">
      <svg viewBox="0 0 64 64" className="mx-auto h-12 w-12 text-brand/40" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M12 10h10v32h30v10H12z" />
        <path d="M12 18h5M12 26h5M12 34h5M30 42v5M38 42v5M46 42v5" />
      </svg>
      <p className="mt-3 font-semibold">{title}</p>
      <p className="mt-1 text-sm text-ink/60">{hint}</p>
    </div>
  );
}

/** A carpenter's square: the L is for Labour, the ticks are the ruler. */
export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="rgb(var(--hero))" />
      <path d="M9 6h5v14h9v5H9z" fill="rgb(var(--gold))" />
      <path d="M9 11h2M9 15h2M9 19h2M14 23v2M18 23v2M22 23v2" stroke="rgb(var(--hero))" strokeWidth="1.2" />
    </svg>
  );
}

const ico = { className: "h-5 w-5", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, viewBox: "0 0 24 24", "aria-hidden": true };
export const SunIcon = () => (<svg {...ico}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
export const MoonIcon = () => (<svg {...ico}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>);
export const HomeIcon = () => (<svg {...ico}><path d="M3 11l9-8 9 8M5 10v10h14V10" /></svg>);
export const FolderIcon = () => (<svg {...ico}><path d="M3 6h6l2 2h10v11H3z" /></svg>);
