import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Tape } from "../components/Tape";
import { Button, Field, Logo, Note } from "../components/ui";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { STAGES } from "../lib/progress";
import type { Market } from "../lib/types";

/** Loops the whole job journey so a first-time visitor sees what the product does before signing in. */
function DemoTape() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setStep((s) => (s + 1) % STAGES.length), 1700);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div>
      <Tape value={step / (STAGES.length - 1)} tone="dark" label="How a job moves from request to done" />
    </div>
  );
}

export default function AuthPage() {
  const { signIn, signUp } = useAuth();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"in" | "up">(params.get("mode") === "up" ? "up" : "in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PRD §2/§127: the market comes from the database, never from a constant in the app.
  const [markets, setMarkets] = useState<Market[]>([]);
  const [market, setMarket] = useState("");
  useEffect(() => {
    api<{ markets: Market[] }>("GET", "/reference").then((r) => {
      setMarkets(r.markets);
      setMarket((cur) => cur || r.markets[0]?.code || "");
    }).catch(() => { /* sign-up reports it if no market could be loaded */ });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "in") await signIn(email.trim(), password);
      else {
        if (!market) throw new Error("No country is available yet. Check your connection and try again");
        await signUp(name.trim(), email.trim(), password, market);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen md:grid-cols-2">
      <section className="adire flex flex-col justify-between gap-12 p-8 text-white md:p-14">
        <Link to="/" className="flex items-center gap-2.5 font-bold"><Logo /> Labour Platform</Link>
        <div>
          <h1 className="max-w-md text-4xl font-bold leading-[1.1] md:text-5xl">Say what needs doing. Get it done, stage by stage.</h1>
          <p className="mt-4 max-w-md text-white/75">Post a job in plain words, compare quotes from people who can do it, and release payment as each stage is approved.</p>
          <div className="mt-10 max-w-md"><DemoTape /></div>
        </div>
        <p className="text-sm text-white/60">Built for homes, businesses and the people who do the work.</p>
      </section>

      <section className="flex items-center justify-center p-6 md:p-12">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4">
          <Link to="/" className="text-sm font-semibold text-ink/60 hover:text-ink">← Back to home</Link>
          <h2 className="text-2xl font-bold">{mode === "in" ? "Welcome back" : "Create your account"}</h2>
          {mode === "up" && <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />}
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          <Field
            label={mode === "up" ? "Password (at least 10 characters)" : "Password"}
            type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "up" ? 10 : 1}
            autoComplete={mode === "up" ? "new-password" : "current-password"}
          />
          {mode === "up" && markets.length > 1 && (
            <label className="block"><span className="mb-1 block text-sm font-medium">Where will you work or hire?</span>
              <select value={market} onChange={(e) => setMarket(e.target.value)} className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base focus:border-brand">
                {markets.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
              </select>
            </label>
          )}
          {error && <Note>{error}</Note>}
          <Button type="submit" variant="gold" busy={busy} className="w-full py-3">{mode === "in" ? "Sign in" : "Create account"}</Button>
          <button type="button" onClick={() => { setMode(mode === "in" ? "up" : "in"); setError(null); }} className="text-sm font-semibold text-brand underline">
            {mode === "in" ? "I need an account" : "I already have an account"}
          </button>
        </form>
      </section>
    </div>
  );
}
