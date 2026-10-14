import { useEffect, useState } from "react";
import { STAGES } from "../lib/progress";

type Props = { value: number; compact?: boolean; tone?: "light" | "dark"; label?: string };

/** Progress drawn as a tape measure that extends along its ticks. It animates in from zero on mount. */
export function Tape({ value, compact = false, tone = "light", label }: Props) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(id);
  }, [value]);

  const dark = tone === "dark";
  const pct = Math.max(0, Math.min(1, shown)) * 100;
  const active = Math.round(value * (STAGES.length - 1));

  return (
    <div role="progressbar" aria-label={label ?? "Project progress"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div className={`relative overflow-hidden rounded-md ${dark ? "bg-white/15" : "bg-brand/10"} ${compact ? "h-3.5" : "h-9"}`}>
        <div className="tape-fill absolute inset-y-0 left-0 bg-gold" style={{ width: `${pct}%` }} />
        <div className={`pointer-events-none absolute inset-x-0 bottom-0 ${dark ? "tape-ticks-dark" : "tape-ticks"}`} style={{ height: compact ? 5 : 12 }} />
        <div className={`tape-pin absolute inset-y-0 w-0.5 ${dark ? "bg-white" : "bg-ink"}`} style={{ left: `calc(${pct}% - 1px)` }} />
      </div>
      {!compact && (
        <div className="mt-2 flex justify-between text-xs">
          {STAGES.map((s, i) => (
            <span key={s} className={i <= active ? (dark ? "font-semibold text-white" : "font-semibold text-ink") : dark ? "text-white/50" : "text-ink/50"}>
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
