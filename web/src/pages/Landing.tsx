import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Tape } from "../components/Tape";
import { CategoryIcon, ArrowRight, ChatIcon, CheckIcon, GlobeIcon, LayersIcon, ShieldIcon, SparkIcon, WalletIcon, CameraIcon, RefreshIcon, WarnIcon } from "../components/Icons";
import { Logo, MoonIcon, SunIcon } from "../components/ui";
import { Reveal, prefersReducedMotion, useInView, useScrollProgress, useTypeLines } from "../lib/motion";
import { CATEGORIES, EXAMPLES, PATH_INFO, understand } from "../lib/taxonomy";
import { STAGES } from "../lib/progress";
import { useTheme } from "../lib/theme";

const SIGN_UP = "/auth?mode=up";
const SIGN_IN = "/auth";

function Soon({ live }: { live: boolean }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${live ? "bg-signal/15 text-signal" : "bg-gold/25 text-caution"}`}>{live ? "Live" : "Coming"}</span>;
}

function SectionTitle({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-bold uppercase tracking-widest text-caution">{kicker}</p>
      <h2 className="mt-2 text-3xl font-bold leading-tight md:text-5xl">{title}</h2>
      {children && <p className="mt-4 text-lg text-ink/70">{children}</p>}
    </Reveal>
  );
}

/* ───────────── nav ───────────── */
function Nav() {
  const { theme, toggle } = useTheme();
  const p = useScrollProgress();
  const scrolled = p > 0.005;
  return (
    <>
      <div aria-hidden className="fixed inset-x-0 top-0 z-[60] h-1"><div className="h-full origin-left bg-gold" style={{ transform: `scaleX(${p})` }} /></div>
      <header className={`fixed inset-x-0 top-1 z-50 transition ${scrolled ? "border-b border-line bg-paper/85 backdrop-blur" : ""}`}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <Link to="/" className={`flex items-center gap-2.5 font-bold ${scrolled ? "" : "text-white"}`}><Logo /> Labour Platform</Link>
          <nav className={`hidden items-center gap-6 text-sm font-semibold md:flex ${scrolled ? "text-ink/70" : "text-white/80"}`}>
            <a href="#how" className="hover:text-gold">How it works</a>
            <a href="#payments" className="hover:text-gold">Payments</a>
            <a href="#features" className="hover:text-gold">Features</a>
            <a href="#faq" className="hover:text-gold">FAQ</a>
          </nav>
          <div className="flex items-center gap-2">
            <button type="button" onClick={toggle} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} className={`rounded-full p-2 transition hover:bg-white/15 ${scrolled ? "text-ink/70" : "text-white"}`}>
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
            <Link to={SIGN_IN} className={`hidden rounded-xl px-3 py-2 text-sm font-semibold sm:block ${scrolled ? "text-ink" : "text-white"}`}>Sign in</Link>
            <Link to={SIGN_UP} className="rounded-xl bg-gold px-4 py-2 text-sm font-bold text-[#2B1E00] transition hover:brightness-105 active:scale-95">Get started</Link>
          </div>
        </div>
      </header>
    </>
  );
}

/* ───────────── hero ───────────── */
function MiniTape() {
  const [step, setStep] = useState(1);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const id = window.setInterval(() => setStep((s) => (s + 1) % STAGES.length), 1800);
    return () => window.clearInterval(id);
  }, []);
  return <Tape value={step / (STAGES.length - 1)} compact label="Example job progress" />;
}

function HeroDemo() {
  const { text, index } = useTypeLines(EXAMPLES, true);
  const full = text.length > 0 && text === EXAMPLES[index];
  const u = useMemo(() => understand(full ? text : ""), [full, text]);
  return (
    <div className="relative mx-auto w-full max-w-md">
      <div className="floaty absolute -left-3 -top-5 z-10 hidden items-center gap-2 rounded-2xl bg-surface px-3 py-2 text-xs font-semibold text-ink shadow-xl sm:flex" style={{ "--r": "-4deg" } as CSSProperties}>
        <ShieldIcon className="h-4 w-4 text-signal" /> Paid in stages, released on approval
      </div>
      <div className="floaty-slow absolute -bottom-5 -right-3 z-10 hidden items-center gap-2 rounded-2xl bg-surface px-3 py-2 text-xs font-semibold text-ink shadow-xl sm:flex" style={{ "--r": "3deg" } as CSSProperties}>
        <LayersIcon className="h-4 w-4 text-brand" /> Quote v2 accepted
      </div>

      <div className="rounded-3xl bg-surface/95 p-4 text-ink shadow-2xl ring-1 ring-white/20 backdrop-blur">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">What do you need done?</p>
        <div className="mt-2 min-h-[3.25rem] rounded-2xl border border-line bg-paper px-3.5 py-3 text-base">
          {text || <span className="text-ink/30">Describe the job</span>}<span className="caret" aria-hidden />
        </div>
        <div className="mt-3 min-h-[7.5rem]">
          {full && u.top ? (
            <div key={text} className="rise space-y-2.5">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand"><CategoryIcon id={u.top.icon} className="h-5 w-5" /></span>
                <div><p className="font-semibold leading-tight">{u.top.name}</p><p className="text-xs text-ink/60">{PATH_INFO[u.path].label}</p></div>
              </div>
              <MiniTape />
              <p className="flex items-center gap-1.5 text-xs text-ink/60"><SparkIcon className="h-3.5 w-3.5 text-gold" /> Understood in plain words, no form to fill</p>
            </div>
          ) : (
            <div className="space-y-2.5" aria-hidden>
              <div className="skeleton h-10 w-2/3" /><div className="skeleton h-3.5" /><div className="skeleton h-3 w-1/2" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="adire relative overflow-hidden pb-24 pt-32 text-white md:pb-32 md:pt-40">
      <div aria-hidden className="glow-orb pointer-events-none absolute -left-24 top-10 h-80 w-80 rounded-full" />
      <div aria-hidden className="glow-orb glow-orb-b pointer-events-none absolute -right-24 bottom-0 h-96 w-96 rounded-full" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 md:grid-cols-2">
        <div className="rise">
          <p className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-semibold"><span className="h-2 w-2 animate-pulse rounded-full bg-gold" /> For homes, businesses and the people who do the work</p>
          <h1 className="mt-5 text-5xl font-bold leading-[1.02] md:text-7xl">Say what needs doing.</h1>
          <p className="shimmer-text mt-2 text-4xl font-bold leading-[1.05] md:text-6xl">We will take it from there.</p>
          <p className="mt-6 max-w-lg text-lg text-white/80">Describe the job in your own words. Compare quotes from people who can do it. Pay as each stage is approved, with the proof kept for both sides.</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to={SIGN_UP} className="group inline-flex items-center gap-2 rounded-2xl bg-gold px-6 py-3.5 text-base font-bold text-[#2B1E00] shadow-lg transition hover:brightness-105 active:scale-95">Post a job <ArrowRight className="h-5 w-5 transition group-hover:translate-x-1" /></Link>
            <a href="#how" className="rounded-2xl border border-white/30 px-6 py-3.5 text-base font-semibold transition hover:bg-white/10">See how it works</a>
          </div>
          <p className="mt-5 text-sm text-white/60">Free to start. Nothing begins until you accept.</p>
        </div>
        <HeroDemo />
      </div>
      <svg aria-hidden viewBox="0 0 1440 60" preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-10 w-full text-paper md:h-14"><path fill="currentColor" d="M0 60V30c240 30 480 30 720 10s480-30 720-10v30z" /></svg>
    </section>
  );
}

/* ───────────── marquee ───────────── */
function Marquee() {
  const rowA = [...EXAMPLES, "Clean my apartment tomorrow", "My AC is not cooling", "We need to organise a conference"];
  const rowB = ["I am relocating my office", "Maintain 200 facilities", "I need an architect for my plot", "Trim the hedge and cut the grass", "We have cockroaches in the kitchen", "My generator won't start"];
  const row = (items: string[], rev = false) => (
    <div className="overflow-hidden"><div className={`marquee ${rev ? "marquee-rev" : ""}`}>
      {[...items, ...items].map((t, i) => <span key={i} className="mx-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium">{t}</span>)}
    </div></div>
  );
  return (
    <section aria-label="Things people ask for" className="space-y-3 py-6">
      <p className="text-center text-sm font-semibold text-ink/50">People ask for things like</p>
      {row(rowA)}{row(rowB, true)}
    </section>
  );
}

/* ───────────── three paths ───────────── */
const PATHS = [
  { n: "A", title: "Quick service", body: "You know what you need. Clean my apartment tomorrow.", steps: ["Request", "Match", "Quote", "Perform", "Pay"], icon: "broom" as const },
  { n: "B", title: "Scope it together", body: "You know the outcome, not the spec. I want a solar system.", steps: ["Describe", "Questions", "Scope", "Quotes", "Start"], icon: "sun" as const },
  { n: "C", title: "Managed project", body: "Several people, stages and approvals. We are relocating our office.", steps: ["Stages", "Tasks", "People", "Milestones", "Handover"], icon: "truck" as const },
];

function Paths() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 md:py-28">
      <SectionTitle kicker="One platform, any size of job" title="Simple stays simple. Big gets organised.">Start with one sentence. The platform decides how much structure the job needs, and no more than that.</SectionTitle>
      <div className="mt-12 grid gap-5 md:grid-cols-3">
        {PATHS.map((p, i) => (
          <Reveal key={p.n} delay={i * 120}>
            <article className="lift h-full rounded-3xl border border-line bg-surface p-6">
              <div className="flex items-center justify-between">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand"><CategoryIcon id={p.icon} className="h-6 w-6" /></span>
                <span className="text-5xl font-bold text-ink/10">{p.n}</span>
              </div>
              <h3 className="mt-4 text-xl font-bold">{p.title}</h3>
              <p className="mt-1.5 text-ink/70">{p.body}</p>
              <ol className="mt-5 flex flex-wrap gap-1.5 text-xs font-semibold">
                {p.steps.map((s, k) => <li key={s} className="flex items-center gap-1.5"><span className="rounded-full bg-brand/10 px-2.5 py-1 text-brand">{s}</span>{k < p.steps.length - 1 && <span className="text-ink/30">→</span>}</li>)}
              </ol>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ───────────── try it ───────────── */
function TryIt() {
  const [q, setQ] = useState("The room has no power");
  const u = useMemo(() => understand(q), [q]);
  return (
    <section className="adire text-white">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-20 md:grid-cols-2 md:py-28">
        <Reveal>
          <p className="text-sm font-bold uppercase tracking-widest text-gold">Try it, no sign-up</p>
          <h2 className="mt-2 text-3xl font-bold leading-tight md:text-5xl">You do not need to know the trade.</h2>
          <p className="mt-4 max-w-md text-lg text-white/75">Say what is wrong. We work out what kind of help it is, how big the job is, and whether it might be an emergency.</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {["My door won't lock", "There is water coming from the ceiling", "I want backup electricity for my house", "We are relocating our office"].map((ex) => (
              <button key={ex} type="button" onClick={() => setQ(ex)} className={`rounded-full border px-3 py-1.5 text-sm transition active:scale-95 ${q === ex ? "border-gold bg-gold text-[#2B1E00]" : "border-white/25 bg-white/10 hover:bg-white/20"}`}>{ex}</button>
            ))}
          </div>
        </Reveal>
        <Reveal delay={150}>
          <div className="rounded-3xl bg-surface p-5 text-ink shadow-2xl">
            <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} aria-label="Describe a problem" placeholder="Type a problem" className="w-full rounded-2xl border border-line bg-paper px-4 py-3 text-base focus:border-brand focus:outline-none" />
            <div key={`${u.top?.key}-${u.path}-${!!u.emergency}`} className="rise mt-4 space-y-3">
              {u.emergency && (
                <div role="alert" className="flex gap-2.5 rounded-xl border border-alarm/50 bg-alarm/10 p-3 text-sm text-alarm"><WarnIcon className="mt-0.5 h-5 w-5 shrink-0" /><p>Possible {u.emergency.kind}. Contact your local emergency services first. We are a marketplace, not an emergency service.</p></div>
              )}
              {u.top ? (
                <>
                  <div className="flex items-center gap-3">
                    <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand/10 text-brand"><CategoryIcon id={u.top.icon} className="h-6 w-6" /></span>
                    <div><p className="text-lg font-bold leading-tight">{u.top.name}</p><p className="text-sm text-ink/60">{u.top.blurb}</p></div>
                  </div>
                  <div className="rounded-xl bg-brand/5 p-3 text-sm"><p className="font-semibold">{PATH_INFO[u.path].label}</p><p className="mt-1 text-ink/70">{PATH_INFO[u.path].why}</p></div>
                </>
              ) : (
                <p className="text-ink/60">{q.trim() ? "I could not place that yet. In the app you can add detail and it gets clearer." : "Type something above."}</p>
              )}
            </div>
            <p className="mt-4 text-xs text-ink/50">Simple rules on your device, not an AI. An optional AI assistant comes later and never replaces your say.</p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ───────────── journey ───────────── */
const JOURNEY: { t: string; d: string; live: boolean }[] = [
  { t: "Requirement", d: "Describe the job by typing. Voice and photos are on the way.", live: true },
  { t: "Scope", d: "Turn a rough idea into something a professional can quote.", live: false },
  { t: "Project", d: "One project holds the stages, tasks, budget and people.", live: true },
  { t: "Tasks", d: "Break the work into pieces, with the order they depend on.", live: true },
  { t: "People", d: "Invite providers, receive quotes, keep every version.", live: true },
  { t: "Schedule", d: "Agree times in each person's own time zone.", live: false },
  { t: "Evidence", d: "Photos, notes and measurements tied to the task or milestone.", live: true },
  { t: "Changes", d: "Every change is proposed, priced and agreed. Never silent.", live: false },
  { t: "Approvals", d: "You approve a milestone before it counts as done.", live: true },
  { t: "Payments", d: "Money moves on approval, not on promises.", live: true },
  { t: "Completion", d: "Final sign-off, with the full record kept.", live: true },
  { t: "Aftercare", d: "Warranties, reminders and hiring the same person again.", live: false },
];

function Journey() {
  const [ref, seen] = useInView<HTMLOListElement>(0.05);
  return (
    <section id="how" className="mx-auto max-w-4xl px-5 py-20 md:py-28">
      <SectionTitle kicker="From a sentence to a warranty" title="Every job follows the same honest path.">The same engine runs a leaking tap and a 200-site programme. You only see the steps you need.</SectionTitle>
      <ol ref={ref} className="relative mt-14">
        <span aria-hidden className={`journey-line absolute bottom-3 left-[19px] top-3 w-0.5 bg-gold ${seen ? "journey-line-in" : ""}`} />
        {JOURNEY.map((s, i) => (
          <li key={s.t} className="relative">
            <Reveal delay={Math.min(i, 6) * 60} className="flex gap-5 pb-7">
              <span className="relative z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 border-gold bg-paper text-sm font-bold">{i + 1}</span>
              <div className="min-w-0 pt-1">
                <h3 className="flex flex-wrap items-center gap-2 text-lg font-bold">{s.t} <Soon live={s.live} /></h3>
                <p className="mt-0.5 text-ink/70">{s.d}</p>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ───────────── payments ───────────── */
const PAY = ["You fund the stage", "Funds are set aside", "Work and proof arrive", "You approve", "Provider is paid"];

function Payments() {
  const [active, setActive] = useState(0);
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  useEffect(() => {
    if (!seen || prefersReducedMotion()) { if (seen) setActive(PAY.length - 1); return; }
    const id = window.setInterval(() => setActive((a) => (a + 1) % PAY.length), 1700);
    return () => window.clearInterval(id);
  }, [seen]);
  const pct = (active / (PAY.length - 1)) * 100;
  return (
    <section id="payments" className="adire text-white">
      <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-bold uppercase tracking-widest text-gold">Protected payment</p>
          <h2 className="mt-2 text-3xl font-bold leading-tight md:text-5xl">Both sides can relax.</h2>
          <p className="mt-4 text-lg text-white/75">Each stage is funded before work starts and released only when you approve it. How funds are held depends on what is allowed in your country.</p>
        </Reveal>
        <div ref={ref} className="mx-auto mt-14 max-w-4xl">
          <div className="relative">
            <div className="absolute inset-x-[10%] top-5 h-1 rounded bg-white/15" />
            <div className="absolute left-[10%] top-5 h-1 rounded bg-gold transition-all duration-1000" style={{ width: `${pct * 0.8}%` }} />
            <ol className="relative grid grid-cols-5 gap-1">
              {PAY.map((s, i) => (
                <li key={s} className="flex flex-col items-center text-center">
                  <span className={`grid h-11 w-11 place-items-center rounded-full border-2 text-sm font-bold transition-all duration-500 ${i < active ? "border-gold bg-gold text-[#2B1E00]" : i === active ? "pay-now border-gold bg-white text-[#2B1E00]" : "border-white/30 bg-hero text-white/60"}`}>
                    {i < active ? <CheckIcon className="h-5 w-5" /> : i + 1}
                  </span>
                  <span className={`mt-3 text-xs font-semibold leading-tight transition md:text-sm ${i <= active ? "text-white" : "text-white/50"}`}>{s}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="mt-14 grid gap-4 md:grid-cols-3">
            {[
              { i: <WalletIcon className="h-5 w-5" />, t: "Fees on the record", d: "Any platform fee is calculated by rule and recorded with each release." },
              { i: <CameraIcon className="h-5 w-5" />, t: "Proof, not promises", d: "Evidence is attached to the task or milestone it belongs to." },
              { i: <ShieldIcon className="h-5 w-5" />, t: "Retry-safe", d: "A repeated tap or a dropped connection is recognised and not processed twice." },
            ].map((c, k) => (
              <Reveal key={c.t} delay={k * 100}><div className="h-full rounded-2xl border border-white/15 bg-white/10 p-5"><span className="grid h-9 w-9 place-items-center rounded-xl bg-gold text-[#2B1E00]">{c.i}</span><h3 className="mt-3 font-bold">{c.t}</h3><p className="mt-1 text-sm text-white/75">{c.d}</p></div></Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────── translated chat ───────────── */
type Bubble = { from: "customer" | "provider"; es: string; pt: string };
const CHAT: Bubble[] = [
  { from: "customer", es: "Quiero instalar energía solar en mi casa.", pt: "Quero instalar energia solar na minha casa." },
  { from: "provider", es: "Puedo hacer una inspección mañana por la mañana.", pt: "Posso fazer uma inspeção amanhã de manhã." },
  { from: "customer", es: "Perfecto. ¿También pueden revisar el tablero eléctrico?", pt: "Perfeito. Vocês também podem verificar o quadro elétrico?" },
  { from: "provider", es: "Sí, está incluido en la inspección.", pt: "Sim, está incluído na inspeção." },
];

function ChatDemo() {
  const [viewer, setViewer] = useState<"customer" | "provider">("customer");
  const [shown, setShown] = useState(0);
  const [orig, setOrig] = useState<Set<number>>(new Set());
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (!seen) return;
    setShown(0);
    if (prefersReducedMotion()) { setShown(CHAT.length); return; }
    let n = 0;
    const id = window.setInterval(() => { n += 1; setShown(n); if (n >= CHAT.length) window.clearInterval(id); }, 1200);
    return () => window.clearInterval(id);
  }, [seen, run]);
  const lang = viewer === "customer" ? "es" : "pt";
  const names = { es: "Español", pt: "Português" } as const;
  const flip = (i: number) => setOrig((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });

  return (
    <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 md:grid-cols-2 md:py-28">
      <Reveal>
        <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-caution">Speak your language <Soon live={false} /></p>
        <h2 className="mt-2 text-3xl font-bold leading-tight md:text-5xl">A customer in Spanish. An installer in Portuguese. One conversation.</h2>
        <p className="mt-4 text-lg text-ink/70">Messages are translated for whoever reads them. The original is always kept and one tap away, so nothing is lost if a word is disputed later.</p>
        <ul className="mt-6 space-y-3 text-ink/80">
          {["Chat stays attached to the task, quote or change it is about", "Quotes, prices and safety notes ask you to confirm you understood", "You choose your language and whether to see originals"].map((t) => (
            <li key={t} className="flex gap-3"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-signal/15 text-signal"><CheckIcon className="h-3 w-3" /></span>{t}</li>
          ))}
        </ul>
      </Reveal>
      <Reveal delay={150}>
        <div ref={ref} className="rounded-3xl border border-line bg-surface p-4 shadow-xl">
          <div className="flex items-center justify-between gap-2">
            <div role="tablist" aria-label="Whose screen" className="flex rounded-full bg-brand/10 p-1 text-xs font-bold">
              {(["customer", "provider"] as const).map((v) => (
                <button key={v} role="tab" aria-selected={viewer === v} type="button" onClick={() => { setViewer(v); setOrig(new Set()); }} className={`rounded-full px-3 py-1.5 transition ${viewer === v ? "bg-brand text-onbrand" : "text-ink/60"}`}>{v === "customer" ? "Customer · Español" : "Provider · Português"}</button>
              ))}
            </div>
            <button type="button" onClick={() => setRun((r) => r + 1)} aria-label="Replay" className="rounded-full p-2 text-ink/50 transition hover:bg-brand/10 hover:text-ink"><RefreshIcon className="h-4 w-4" /></button>
          </div>
          <div className="mt-4 min-h-[19rem] space-y-3" aria-live="polite">
            {CHAT.slice(0, shown).map((m, i) => {
              const mine = m.from === viewer;
              const origLang = m.from === "customer" ? "es" : "pt";
              const translated = origLang !== lang;
              const showOrig = orig.has(i);
              const text = showOrig ? m[origLang] : m[lang];
              return (
                <div key={`${viewer}-${i}`} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                  <div className={`${mine ? "bubble-in-r rounded-br-md bg-brand text-onbrand" : "bubble-in-l rounded-bl-md bg-brand/10"} max-w-[85%] rounded-2xl px-4 py-2.5`}>{text}</div>
                  {translated && (
                    <button type="button" onClick={() => flip(i)} className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-ink/55 hover:text-ink"><GlobeIcon className="h-3 w-3" />{showOrig ? `Original · ${names[origLang]} · Show translation` : `Translated from ${names[origLang]} · View original`}</button>
                  )}
                </div>
              );
            })}
            {shown > 0 && shown < CHAT.length && <div className="bubble-in-l flex w-fit rounded-2xl rounded-bl-md bg-brand/10 px-4 py-3"><span className="dots dots-lg"><span /><span /><span /></span></div>}
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ───────────── features ───────────── */
const FEATURES: { i: ReactNode; t: string; d: string; live: boolean }[] = [
  { i: <LayersIcon />, t: "Quotes you can compare", d: "Every revision is kept, so what you accepted is never in doubt.", live: true },
  { i: <ShieldIcon />, t: "Milestone approvals", d: "Pay by stage. Approve, or ask for changes.", live: true },
  { i: <CameraIcon />, t: "Proof of work", d: "Evidence attached to the exact task or milestone.", live: true },
  { i: <WalletIcon />, t: "Provider payouts", d: "Earnings are tracked and paid out after review.", live: true },
  { i: <ChatIcon />, t: "Chat that knows the context", d: "A thread per task, quote and change. No one long scroll.", live: false },
  { i: <GlobeIcon />, t: "Translated everywhere", d: "Chat, scope and updates in each person's language.", live: false },
  { i: <SparkIcon />, t: "Optional AI planning", d: "Draft a project from a sentence. You review before anything starts.", live: false },
  { i: <RefreshIcon />, t: "Assets and aftercare", d: "Warranties, service history and hire-again in one tap.", live: false },
];

function Features() {
  return (
    <section id="features" className="bg-brand/5">
      <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
        <SectionTitle kicker="What is inside" title="Built around accountability.">Everything is there to answer one question: what was agreed, and did it happen?</SectionTitle>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => (
            <Reveal key={f.t} delay={(i % 4) * 90}>
              <article className="lift h-full rounded-2xl border border-line bg-surface p-5">
                <div className="flex items-center justify-between"><span className="grid h-11 w-11 place-items-center rounded-xl bg-brand/10 text-brand">{f.i}</span><Soon live={f.live} /></div>
                <h3 className="mt-4 font-bold">{f.t}</h3>
                <p className="mt-1 text-sm text-ink/70">{f.d}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────── audiences ───────────── */
const AUDIENCES = {
  Households: { head: "Fix it, move it, build it.", points: ["Describe the problem, not the profession", "See what is included before you agree", "Pay only for work you have approved"] },
  Businesses: { head: "Keep every site running.", points: ["Budgets, approvals and preferred providers (planned)", "Recurring maintenance across locations (planned)", "One record for every job and invoice (planned)"] },
  Providers: { head: "Turn skill into a track record.", points: ["Get invited to work that fits you", "Be paid as each stage is approved", "Build a history customers can trust"] },
  Institutions: { head: "Connect training to real work.", points: ["Verified worker pools by region (planned)", "Track work obtained and earnings (planned)", "Aggregated insight with privacy kept (planned)"] },
} as const;

function Audiences() {
  const keys = Object.keys(AUDIENCES) as (keyof typeof AUDIENCES)[];
  const [k, setK] = useState<keyof typeof AUDIENCES>("Households");
  const a = AUDIENCES[k];
  return (
    <section className="mx-auto max-w-5xl px-5 py-20 md:py-28">
      <SectionTitle kicker="Who it is for" title="Made for both sides of the work." />
      <Reveal className="mt-10">
        <div role="tablist" className="no-scrollbar flex justify-center gap-2 overflow-x-auto">
          {keys.map((x) => <button key={x} role="tab" aria-selected={k === x} type="button" onClick={() => setK(x)} className={`shrink-0 rounded-full px-5 py-2.5 text-sm font-bold transition active:scale-95 ${k === x ? "bg-brand text-onbrand" : "border border-line bg-surface text-ink/70 hover:text-ink"}`}>{x}</button>)}
        </div>
        <div key={k} className="rise mx-auto mt-8 max-w-2xl rounded-3xl border border-line bg-surface p-7 text-center">
          <h3 className="text-2xl font-bold md:text-3xl">{a.head}</h3>
          <ul className="mt-5 space-y-2.5 text-left text-ink/80">
            {a.points.map((p) => <li key={p} className="flex gap-3"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-gold/30 text-caution"><CheckIcon className="h-3 w-3" /></span>{p}</li>)}
          </ul>
          <Link to={SIGN_UP} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-onbrand transition hover:opacity-90 active:scale-95">{k === "Providers" ? "Create a provider profile" : "Get started"} <ArrowRight className="h-4 w-4" /></Link>
        </div>
      </Reveal>
    </section>
  );
}

/* ───────────── principles + faq + footer ───────────── */
function Principles() {
  const items = [
    { t: "AI suggests. You decide.", d: "Nothing becomes real until you accept it." },
    { t: "Originals are never overwritten.", d: "Messages, quotes and agreements keep their history." },
    { t: "Changes are never silent.", d: "A new price or scope needs everyone's yes." },
  ];
  return (
    <section className="border-y border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-6 px-5 py-10 md:grid-cols-3">
        {items.map((p, i) => <Reveal key={p.t} delay={i * 100}><p className="font-bold">{p.t}</p><p className="mt-1 text-sm text-ink/70">{p.d}</p></Reveal>)}
      </div>
    </section>
  );
}

const FAQ = [
  { q: "Do I have to use AI?", a: "No. You can describe a job, get quotes and run the whole project without it. AI planning is optional and, when it arrives, it only suggests. You review before anything starts." },
  { q: "How does protected payment work?", a: "The money for a stage is put aside first. When the work and proof are in and you approve, it is released to the provider. How funds are held depends on what is allowed in your country." },
  { q: "What if the job changes halfway?", a: "Changes to tasks and budget are proposed, agreed and recorded against the original. Changes to milestones and payments are not covered yet." },
  { q: "Is this for emergencies?", a: "No. For fire, gas, medical or safety emergencies, contact your local emergency services first. We will tell you if your request sounds like one." },
  { q: "Where does it work?", a: "It is built so each country is configured, with its own language, currency, payments and rules. Nigeria is the first market." },
];

function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-5 py-20 md:py-28">
      <SectionTitle kicker="Questions" title="Good things to ask." />
      <div className="mt-10 space-y-3">
        {FAQ.map((f, i) => (
          <Reveal key={f.q} delay={i * 60}>
            <details className="faq rounded-2xl border border-line bg-surface p-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-bold">{f.q}<span className="faq-plus grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand/10 text-brand" aria-hidden>+</span></summary>
              <p className="mt-3 text-ink/70">{f.a}</p>
            </details>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="adire relative overflow-hidden text-white">
      <div aria-hidden className="glow-orb pointer-events-none absolute left-1/2 top-0 h-72 w-72 -translate-x-1/2 rounded-full" />
      <div className="relative mx-auto max-w-3xl px-5 py-24 text-center md:py-32">
        <Reveal>
          <h2 className="text-4xl font-bold leading-tight md:text-6xl">What do you need done?</h2>
          <p className="mx-auto mt-4 max-w-lg text-lg text-white/75">Say it in one sentence. It takes a minute to post and nothing starts until you say so.</p>
          <div className="mx-auto mt-8 max-w-sm"><Tape value={1} tone="dark" label="From request to done" /></div>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to={SIGN_UP} className="inline-flex items-center gap-2 rounded-2xl bg-gold px-7 py-4 text-base font-bold text-[#2B1E00] shadow-lg transition hover:brightness-105 active:scale-95">Post a job <ArrowRight className="h-5 w-5" /></Link>
            <Link to={SIGN_IN} className="rounded-2xl border border-white/30 px-7 py-4 text-base font-semibold transition hover:bg-white/10">Sign in</Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-paper">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm text-ink/60 md:flex-row">
        <span className="flex items-center gap-2 font-bold text-ink"><Logo className="h-7 w-7" /> Labour Platform</span>
        <span>Built for homes, businesses and the people who do the work.</span>
        <span className="flex gap-4"><a href="#how" className="hover:text-ink">How it works</a><Link to={SIGN_IN} className="hover:text-ink">Sign in</Link></span>
      </div>
      <p className="pb-6 text-center text-xs text-ink/40">Services covered include {CATEGORIES.slice(0, 6).map((c) => c.name.toLowerCase()).join(", ")} and more.</p>
    </footer>
  );
}

export default function Landing() {
  return (
    <div className="overflow-x-clip">
      <Nav />
      <main>
        <Hero />
        <Marquee />
        <Paths />
        <TryIt />
        <Journey />
        <Payments />
        <ChatDemo />
        <Features />
        <Audiences />
        <Principles />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
