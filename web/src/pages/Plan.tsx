import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, TrustBadge, useRun } from "../components/kit";
import { CategoryIcon, SparkIcon, WarnIcon } from "../components/Icons";
import { Button, Note, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { CATEGORIES, EMERGENCY_NOTE, PATH_INFO, type RequestPath } from "../lib/taxonomy";
import type { Market } from "../lib/types";
import { useLoad } from "../lib/useLoad";

// PRD §4 paths B and C, §16-21: describe -> a few questions -> a draft you review -> accept. Nothing is created as a project
// until you accept, and the whole flow works with AI switched off (it then uses templates and simple rules).

type Cls = { topKey: string | null; matches: { key: string; name: string; risk: string }[]; confident: boolean; path: RequestPath; emergency: { kind: string } | null };
type Q = { id: string; text: string };
type Task = { key: string; title: string; description?: string; dependsOn: string[]; inspectionRequired: boolean; acceptanceCriteria?: string; skills: string[] };
type Draft = { id: string; source: string; labels: string[]; warnings: string[]; payload: { title: string; objective?: string; stages: { name: string; tasks: Task[] }[]; assumptions: string[]; risks: string[]; materials: string[]; questionsForProfessional: string[] } };

export default function Plan() {
  const { user } = useAuth();
  const nav = useNavigate();
  const { busy, run } = useRun();
  const reference = useLoad(() => api<{ markets: Market[] }>("GET", "/reference"));
  const [step, setStep] = useState<"describe" | "questions" | "review">("describe");
  const [text, setText] = useState("");
  const [cls, setCls] = useState<Cls | null>(null);
  const [questions, setQuestions] = useState<Q[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [source, setSource] = useState("rules");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState("");
  const [currency, setCurrency] = useState("");
  const [error, setError] = useState<string | null>(null);

  const market = reference.data?.markets.find((m) => m.id === user?.marketId) ?? reference.data?.markets[0];
  const cur = currency || market?.defaultCurrency || "";
  const top = cls?.matches[0];
  const meta = CATEGORIES.find((c) => c.key === cls?.topKey);

  async function understand() {
    setError(null);
    const [c, q] = await Promise.all([
      api<{ classification: Cls }>("POST", "/discover/classify", { text: text.trim(), useAi: true }),
      api<{ questions: Q[]; source: string }>("POST", "/ai/questions", { text: text.trim() }),
    ]);
    setCls(c.classification);
    setQuestions(q.questions);
    setSource(q.source);
    setStep("questions");
  }

  async function buildDraft() {
    setError(null);
    const answered = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
    let id = requestId;
    if (!id) {
      const r = await api<{ request: { id: string } }>("POST", "/requests", { rawText: text.trim(), status: "open", path: cls?.path ?? "ai_assisted" });
      id = r.request.id;
      setRequestId(id);
    }
    const d = await api<{ draft: Draft }>("POST", `/requests/${id}/drafts`, { answers: answered, ...(cls?.topKey ? { categoryKey: cls.topKey } : {}) });
    setDraft(d.draft);
    setTitle(d.draft.payload.title);
    setStep("review");
  }

  async function accept() {
    if (!draft) return;
    const r = await api<{ project: { id: string } }>("POST", `/drafts/${draft.id}/accept`, { currency: cur, title: title.trim() || undefined });
    nav(`/projects/${r.project.id}`);
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-caution"><SparkIcon className="h-3.5 w-3.5" /> Plan a project</p>
        <h1 className="mt-1 text-3xl font-bold">Tell us the outcome. We will shape the plan.</h1>
        <p className="mt-1 text-ink/70">You review everything before it becomes a project. Prefer to skip planning? <Link to="/" className="font-semibold underline">Post a simple request</Link>.</p>
      </header>
      <ol className="flex gap-2 text-xs font-semibold">{(["describe", "questions", "review"] as const).map((s, i) => <li key={s} className={`rounded-full px-3 py-1 ${step === s ? "bg-brand text-onbrand" : "bg-brand/10 text-brand"}`}>{i + 1}. {s === "describe" ? "Describe" : s === "questions" ? "A few questions" : "Review the plan"}</li>)}</ol>
      {error && <Note>{error}</Note>}

      {step === "describe" && (
        <Card>
          <label className="block text-sm font-medium">What do you want to achieve?
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000} placeholder="I want backup electricity for my house" className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base font-normal" />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">{["I want solar installed", "I am moving to another house", "We need two rooms repainted", "I want to renovate my kitchen"].map((e) => <button key={e} type="button" onClick={() => setText(e)} className="rounded-full border border-line px-3 py-1.5 text-sm hover:bg-brand/5">{e}</button>)}</div>
          <Button className="mt-4" variant="gold" disabled={text.trim().length < 3} busy={busy === "u"} onClick={() => void run("u", understand).then(() => undefined)}>Continue</Button>
        </Card>
      )}

      {step === "questions" && cls && (
        <div className="space-y-4">
          {cls.emergency && <div role="alert" className="flex gap-2.5 rounded-xl border border-alarm/50 bg-alarm/10 p-3 text-sm text-alarm"><WarnIcon className="mt-0.5 h-5 w-5 shrink-0" /><p><span className="font-semibold">Possible {cls.emergency.kind}. </span>{EMERGENCY_NOTE}</p></div>}
          <Card title="How we read it" action={<TrustBadge source={source === "ai" ? "ai" : undefined} labels={source === "ai" ? [] : ["rules_generated"]} />}>
            <div className="flex items-center gap-3">
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand/10 text-brand">{meta ? <CategoryIcon id={meta.icon} className="h-6 w-6" /> : <SparkIcon className="h-6 w-6" />}</span>
              <div><p className="font-semibold">{top?.name ?? "We could not place this in one trade"}</p><p className="text-sm text-ink/60">{PATH_INFO[cls.path].label}. {PATH_INFO[cls.path].why}</p></div>
            </div>
            {top && top.risk === "high" && <p className="mt-3 text-xs text-caution">Higher-risk work. The plan will ask for a qualified professional to confirm the design.</p>}
          </Card>
          <Card title="A few questions" hint="Answer what you can. Skipping is fine, the plan will list what is still unknown.">
            {questions.length === 0 ? <p className="text-sm text-ink/60">No more questions.</p> : (
              <div className="space-y-3">{questions.map((q) => <label key={q.id} className="block text-sm font-medium">{q.text}<input value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} maxLength={1000} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 font-normal" /></label>)}</div>
            )}
            <div className="mt-4 flex gap-2"><Button variant="gold" busy={busy === "d"} onClick={() => void run("d", buildDraft)}>Build my plan</Button><Button variant="quiet" onClick={() => setStep("describe")}>Back</Button></div>
          </Card>
        </div>
      )}

      {step === "review" && draft && (
        <div className="space-y-4">
          <Card title="Your plan" hint="This is a proposal. Change the title if you like. Nothing is created until you accept." action={<TrustBadge labels={draft.labels} />}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label="Project title" className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-lg font-semibold" />
            {draft.payload.objective && <p className="mt-2 text-sm text-ink/70">{draft.payload.objective}</p>}
          </Card>
          {draft.warnings.map((w, i) => <Note key={i} tone="info">{w}</Note>)}
          {draft.payload.stages.map((s, si) => (
            <Card key={si} title={`${si + 1}. ${s.name}`}>
              <ol className="space-y-2.5">{s.tasks.map((t) => (
                <li key={t.key} className="rounded-xl border border-line p-3">
                  <p className="font-medium">{t.title}{t.inspectionRequired && <span className="ml-2 rounded-full bg-gold/25 px-2 py-0.5 text-[11px] font-bold text-caution">inspection</span>}</p>
                  {t.description && <p className="mt-1 line-clamp-3 text-sm text-ink/70">{t.description}</p>}
                  {t.acceptanceCriteria && <p className="mt-1 text-sm text-signal">Done when: {t.acceptanceCriteria}</p>}
                  {t.dependsOn.length > 0 && <p className="mt-1 text-xs text-ink/50">After: {t.dependsOn.map((k) => s.tasks.concat(draft.payload.stages.flatMap((x) => x.tasks)).find((x) => x.key === k)?.title ?? k).join(", ")}</p>}
                </li>
              ))}</ol>
            </Card>
          ))}
          {([["Assumptions", draft.payload.assumptions], ["Risks", draft.payload.risks], ["Materials likely needed", draft.payload.materials], ["A professional should confirm", draft.payload.questionsForProfessional]] as const).filter(([, l]) => l.length > 0).map(([t, l]) => (
            <Card key={t} title={t}><ul className="list-disc space-y-1 pl-5 text-sm text-ink/80">{l.map((x, i) => <li key={i}>{x}</li>)}</ul></Card>
          ))}
          <Card title="Create the project">
            {reference.loading && !reference.data ? <Skeleton className="h-10" /> : (
              <label className="block text-sm font-medium">Currency<select value={cur} onChange={(e) => setCurrency(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 font-normal">{(market?.currencies ?? []).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="gold" disabled={!cur} busy={busy === "a"} onClick={() => void run("a", accept)}>Accept and create project</Button>
              <Button variant="quiet" busy={busy === "r"} onClick={() => void run("r", async () => { await api("POST", `/drafts/${draft.id}/reject`, {}); setDraft(null); setStep("questions"); })}>Discard this plan</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
