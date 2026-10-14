import { useEffect, useRef, useState } from "react";
import { CheckIcon, SendIcon } from "./Icons";

type Phase = "idle" | "flying" | "done";

/**
 * Send button with a real sequence: press squash, paper plane flies off, check draws in, plane returns.
 * `busy` shows a ring while the request is in flight. `ready` makes it glow gently so people see it is live.
 */
export function SendButton({ ready, busy, onSend, label = "Send" }: { ready: boolean; busy: boolean; onSend: () => void; label?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  function press() {
    if (!ready || busy || phase !== "idle") return;
    try { navigator.vibrate?.(12); } catch { /* not supported */ }
    setPhase("flying");
    timers.current.push(window.setTimeout(() => setPhase("done"), 420));
    timers.current.push(window.setTimeout(() => setPhase("idle"), 1500));
    onSend();
  }

  const live = ready && !busy && phase === "idle";
  return (
    <button
      type="button" onClick={press} disabled={phase === "idle" && (!ready || busy)} aria-label={label}
      className={`send-btn relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-gold text-[#2B1E00] shadow-md transition disabled:cursor-not-allowed disabled:opacity-40 ${live ? "send-ready" : ""}`}
      data-phase={phase}
    >
      {phase === "flying" ? (
        <span className="send-plane send-plane-fly grid place-items-center"><SendIcon className="h-5 w-5 -translate-x-px translate-y-px" /></span>
      ) : phase === "done" ? (
        <CheckIcon className="h-6 w-6" />
      ) : busy ? (
        <span aria-hidden className="h-5 w-5 animate-spin rounded-full border-2 border-[#2B1E00]/70 border-t-transparent" />
      ) : (
        <span className="send-plane grid place-items-center"><SendIcon className="h-5 w-5 -translate-x-px translate-y-px" /></span>
      )}
      {phase === "flying" && <span aria-hidden className="send-burst" />}
    </button>
  );
}
