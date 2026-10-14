import { STEPS, type Action, type Next } from "../lib/journey";
import { Button } from "./ui";

/** Where the project is (7 steps) and the one thing to do next. Always visible, whichever tab is open. */
export function JourneyBar({ next, busy, onAction }: { next: Next; busy: boolean; onAction: (a: Action) => void }) {
  const step = next.step;
  return (
    <section aria-label="Where this project is and what happens next" className="space-y-4">
      <div className="rounded-2xl border border-line bg-surface p-4 sm:pb-9">
        <ol className="flex items-center">
          {STEPS.map((s, i) => {
            const done = i < step;
            const current = i === step;
            return (
              <li key={s} aria-current={current ? "step" : undefined} className="relative flex flex-1 items-center last:flex-none">
                <span
                  title={s}
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold transition ${done ? "bg-signal text-white" : current ? "bg-gold text-[#2B1E00] ring-4 ring-gold/25" : "bg-line text-ink/50"}`}
                >
                  {done ? (
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  ) : (
                    i + 1
                  )}
                </span>
                <span className={`absolute left-3.5 top-9 hidden -translate-x-1/2 whitespace-nowrap text-[11px] sm:block ${current ? "font-semibold text-ink" : "text-ink/50"}`}>{s}</span>
                {i < STEPS.length - 1 && <span className={`mx-1 h-0.5 flex-1 rounded ${done ? "bg-signal" : "bg-line"}`} />}
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-sm text-ink/60 sm:hidden">Step {step + 1} of {STEPS.length}: <span className="font-semibold text-ink">{STEPS[step]}</span></p>
      </div>

      <div key={next.title} className="rise rounded-2xl border border-gold/60 bg-gold/10 p-5">
        <p className="text-xs font-semibold text-ink/60">Your next step</p>
        <h2 className="mt-0.5 text-lg font-semibold">{next.title}</h2>
        <p className="mt-1 text-sm text-ink/75">{next.body}</p>
        {next.action && (
          <Button variant="gold" className="mt-4" busy={busy} disabled={busy} onClick={() => onAction(next.action as Action)}>{next.action.label}</Button>
        )}
      </div>
    </section>
  );
}
