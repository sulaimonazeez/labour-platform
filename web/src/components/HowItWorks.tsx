import { useState } from "react";
import { Link } from "react-router-dom";

// First-run guide in plain words. Hidden once the person closes it; a small link brings it back.
const KEY = "lp_guide_hidden";
const STEPS = [
  { title: "Say what you need", body: "Describe the job in your own words. No technical terms needed." },
  { title: "Compare quotes", body: "Invite providers. Each one sends a price, and you choose." },
  { title: "Fund one stage at a time", body: "Break the job into stages. You fund each stage as you go." },
  { title: "Approve, then it is paid", body: "When a stage is done, check it. The money is released to the provider only when you approve." },
];

export function HowItWorks() {
  const [show, setShow] = useState(() => localStorage.getItem(KEY) !== "1");
  const hide = () => { localStorage.setItem(KEY, "1"); setShow(false); };
  const reopen = () => { localStorage.removeItem(KEY); setShow(true); };

  if (!show) {
    return <button type="button" onClick={reopen} className="text-sm font-semibold text-brand underline">How does this work?</button>;
  }
  return (
    <section aria-label="How it works" className="rise rounded-3xl border border-line bg-surface p-5 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-xl font-semibold">How this works</h2>
        <button type="button" onClick={hide} aria-label="Hide the guide" className="rounded-full p-1.5 text-ink/50 transition hover:bg-brand/10 hover:text-ink">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <ol className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gold text-sm font-bold text-[#2B1E00]">{i + 1}</span>
            <span>
              <span className="block font-semibold leading-tight">{s.title}</span>
              <span className="text-sm text-ink/70">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-sm text-ink/60">
        Do you do the work instead? Offer your skills from your <Link to="/profile" className="font-semibold text-brand underline">profile</Link> and customers can invite you.
      </p>
    </section>
  );
}
