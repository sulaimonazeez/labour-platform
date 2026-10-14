import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** True once the element has scrolled into view. Fires once, then stops observing. */
export function useInView<T extends HTMLElement>(threshold = 0.15) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } },
      { threshold, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, seen] as const;
}

/** Fades and lifts its children in the first time they scroll into view. */
export function Reveal({ children, delay = 0, className = "", style }: { children: ReactNode; delay?: number; className?: string; style?: CSSProperties }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <div ref={ref} className={`reveal ${seen ? "reveal-in" : ""} ${className}`} style={{ transitionDelay: `${delay}ms`, ...style }}>
      {children}
    </div>
  );
}

/** Counts from 0 to `target` once `active` turns true. */
export function useCountUp(target: number, active: boolean, ms = 900): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion() || target === 0) { setN(target); return; }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, active, ms]);
  return n;
}

/** 0..1 of how far the page has been scrolled. Passive listener, one state write per frame at most. */
export function useScrollProgress(): number {
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      setP(h > 0 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };
    window.addEventListener("scroll", onScroll, { passive: true });
    read();
    return () => { window.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);
  return p;
}

/** Types `lines` one after another into a string. Pauses when `active` is false. Reports when a line finishes. */
export function useTypeLines(lines: string[], active = true, onLineDone?: (index: number) => void) {
  const [text, setText] = useState(prefersReducedMotion() ? lines[0] ?? "" : "");
  const [index, setIndex] = useState(0);
  const done = useRef(onLineDone);
  done.current = onLineDone;
  useEffect(() => {
    if (!active || lines.length === 0) return;
    if (prefersReducedMotion()) { setText(lines[0]); return; }
    let i = 0;
    let n = 0;
    let dir: 1 | -1 = 1;
    let timer = 0;
    setText("");
    const tick = () => {
      const word = lines[i];
      n += dir;
      setText(word.slice(0, n));
      setIndex(i);
      let delay = dir === 1 ? 48 : 18;
      if (dir === 1 && n === word.length) { done.current?.(i); dir = -1; delay = 2200; }
      else if (dir === -1 && n === 0) { dir = 1; i = (i + 1) % lines.length; delay = 380; }
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, lines.join("|")]);
  return { text, index };
}
