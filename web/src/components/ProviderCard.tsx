import type { ProviderRow } from "../lib/types";

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
}

export function Avatar({ name, size = "h-11 w-11", text = "text-sm" }: { name: string; size?: string; text?: string }) {
  return (
    <span
      aria-hidden className={`grid shrink-0 place-items-center rounded-full font-bold text-white ${size} ${text}`}
      style={{ background: `linear-gradient(135deg, hsl(${hue(name)} 55% 42%), hsl(${(hue(name) + 40) % 360} 60% 32%))` }}
    >
      {initialsOf(name)}
    </span>
  );
}

/** A provider from the directory. The directory has no distance, rating or availability yet, so none is shown. */
export function ProviderCard({ p, compact = false, onPick, pickLabel }: { p: ProviderRow; compact?: boolean; onPick?: () => void; pickLabel?: string }) {
  return (
    <div className={`rounded-2xl border border-line bg-surface p-3.5 text-ink ${compact ? "w-64 shrink-0 snap-start" : ""}`}>
      <div className="flex items-center gap-3">
        <Avatar name={p.displayName} />
        <div className="min-w-0">
          <p className="truncate font-semibold leading-tight">{p.displayName}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink/60">
            <span className="rounded-full bg-brand/10 px-2 py-0.5 font-semibold text-brand">{p.kind === "company" ? "Company" : "Individual"}</span>
            {p.remoteOk && <span className="rounded-full bg-signal/15 px-2 py-0.5 font-semibold text-signal">Remote OK</span>}
          </p>
        </div>
      </div>
      <p className={`mt-2.5 text-sm text-ink/70 ${compact ? "line-clamp-2" : "line-clamp-3"}`}>{p.headline ?? "No headline yet."}</p>
      {onPick && (
        <button type="button" onClick={onPick} className="mt-3 w-full rounded-xl border border-line px-3 py-2 text-sm font-semibold transition hover:bg-brand/5 active:scale-[0.98]">
          {pickLabel ?? "Choose"}
        </button>
      )}
    </div>
  );
}
