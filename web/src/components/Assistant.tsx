import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { prefersReducedMotion, useTypeLines } from "../lib/motion";
import { EMERGENCY_NOTE, EXAMPLES, PATH_INFO, RISK_NOTE, understand, type Understanding } from "../lib/taxonomy";
import { useToast } from "../lib/toast";
import type { ProviderRow } from "../lib/types";
import { Button } from "./ui";
import { CategoryIcon, MicIcon, RefreshIcon, SparkIcon, WarnIcon } from "./Icons";
import { ProviderCard } from "./ProviderCard";
import { SendButton } from "./SendButton";

type Msg =
  | { id: number; role: "user"; text: string; state: "sending" | "sent" | "failed"; error?: string }
  | { id: number; role: "bot"; kind: "typing" }
  | { id: number; role: "bot"; kind: "reply"; u: Understanding; requestId: string; providers: ProviderRow[] | null };

type SpeechRec = { lang: string; interimResults: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start: () => void; stop: () => void };
type SpeechCtor = new () => SpeechRec;
const speechCtor = (): SpeechCtor | null => {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

async function findProviders(term: string | undefined): Promise<ProviderRow[]> {
  if (!term) return [];
  try {
    const r = await api<{ providers: ProviderRow[] }>("GET", `/providers?q=${encodeURIComponent(term)}`);
    return r.providers.slice(0, 6);
  } catch {
    return [];
  }
}

export function Assistant({ currency, prefill, onPosted }: { currency: string; prefill?: string; onPosted: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState(prefill ?? "");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const idRef = useRef(1);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<SpeechRec | null>(null);
  const canSpeak = typeof window !== "undefined" && speechCtor() !== null;
  const first = (user?.displayName ?? "").split(" ")[0];
  const chatting = msgs.length > 0;

  const typed = useTypeLines(EXAMPLES, text.length === 0 && !focused && !chatting).text;

  // Grow the box with the text, up to about five lines.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  useEffect(() => {
    if (chatting) endRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "end" });
  }, [msgs, chatting]);

  useEffect(() => () => recRef.current?.stop(), []);

  const patch = useCallback((id: number, fn: (m: Msg) => Msg) => setMsgs((all) => all.map((m) => (m.id === id ? fn(m) : m))), []);

  const send = useCallback(async (raw: string, retryOf?: number) => {
    const body = raw.trim();
    if (!body || busy) return;
    const u = understand(body);
    const userId = retryOf ?? idRef.current++;
    const typingId = idRef.current++;
    setBusy(true);
    setMsgs((all) => {
      const base = retryOf ? all.filter((m) => m.role !== "bot" || m.kind !== "typing") : all;
      const withUser: Msg[] = retryOf
        ? base.map((m) => (m.id === userId ? ({ id: userId, role: "user", text: body, state: "sending" } as Msg) : m))
        : [...base, { id: userId, role: "user", text: body, state: "sending" }];
      return [...withUser, { id: typingId, role: "bot", kind: "typing" }];
    });
    if (!retryOf) setText("");

    const t0 = Date.now();
    const payload: Record<string, unknown> = { rawText: body, status: "open", path: u.path };
    if (u.top?.seeded && u.confident) payload.categoryKey = u.top.key;
    try {
      let res: { request: { id: string } };
      try {
        res = await api("POST", "/requests", payload);
      } catch (e) {
        // A category that is not in this database must never block someone from asking for help.
        if (e instanceof ApiError && e.code === "unknown_category") {
          const plain = { ...payload };
          delete plain.categoryKey;
          res = await api("POST", "/requests", plain);
        } else throw e;
      }
      await sleep(Math.max(0, 650 - (Date.now() - t0)));
      patch(userId, (m) => (m.role === "user" ? { ...m, state: "sent" } : m));
      setMsgs((all) => all.map((m) => (m.id === typingId ? { id: typingId, role: "bot", kind: "reply", u, requestId: res.request.id, providers: u.top ? null : [] } : m)));
      onPosted();
      if (u.top) {
        const list = await findProviders(u.top.search);
        patch(typingId, (m) => (m.role === "bot" && m.kind === "reply" ? { ...m, providers: list } : m));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not send that";
      setMsgs((all) => all.filter((m) => m.id !== typingId));
      patch(userId, (m) => (m.role === "user" ? { ...m, state: "failed", error: msg } : m));
    } finally {
      setBusy(false);
    }
  }, [busy, onPosted, patch]);

  async function start(requestId: string) {
    setStarting(requestId);
    try {
      const res = await api<{ project: { id: string } }>("POST", `/requests/${requestId}/convert`, { currency });
      toast.success("Project started");
      nav(`/projects/${res.project.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the project");
      setStarting(null);
    }
  }

  function toggleMic() {
    if (listening) { recRef.current?.stop(); return; }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = user?.preferredLanguage ?? "en";
    rec.interimResults = false;
    rec.onresult = (e) => {
      const said = Array.from(e.results).map((r) => r[0]?.transcript ?? "").join(" ").trim();
      if (said) setText((t) => (t ? `${t} ${said}` : said));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => { setListening(false); toast.error("I could not hear you. Check microphone access."); };
    recRef.current = rec;
    setListening(true);
    rec.start();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // On a keyboard, Enter sends. On touch screens Enter stays a new line and the button sends.
    if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer: fine)").matches) {
      e.preventDefault();
      void send(text);
    }
  }

  const ready = text.trim().length > 0;

  return (
    <section className="adire relative overflow-hidden rounded-3xl p-5 text-white md:p-8">
      <div aria-hidden className="glow-orb pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full" />
      <div className="relative">
        {!chatting ? (
          <div className="rise">
            <p className="text-sm text-white/70">{greeting()}{first ? `, ${first}` : ""}</p>
            <h1 className="mt-1 text-3xl font-bold md:text-4xl">What do you need done?</h1>
            <p className="mt-2 text-sm text-white/70">Say it the way you would tell a friend. Type or tap the microphone.</p>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-semibold text-white/80"><SparkIcon className="h-4 w-4 text-gold" /> Describe the job</p>
            <button type="button" onClick={() => setMsgs([])} disabled={busy} className="rounded-full border border-white/25 px-3 py-1 text-xs font-semibold text-white/80 transition hover:bg-white/10 disabled:opacity-40">New chat</button>
          </div>
        )}

        {chatting && (
          <div className="mt-4 space-y-3" aria-live="polite">
            {msgs.map((m) => {
              if (m.role === "user") {
                return (
                  <div key={m.id} className="flex flex-col items-end">
                    <div className="bubble-in-r max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gold px-4 py-2.5 text-[#2B1E00]">{m.text}</div>
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-white/60">
                      {m.state === "sending" && <>Sending<span className="dots"><span /><span /><span /></span></>}
                      {m.state === "sent" && <span className="tick-in">Delivered</span>}
                      {m.state === "failed" && (
                        <>
                          <span className="text-[#ffb4b4]">{m.error ?? "Not sent"}</span>
                          <button type="button" onClick={() => void send(m.text, m.id)} className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 font-semibold text-white"><RefreshIcon className="h-3 w-3" /> Retry</button>
                        </>
                      )}
                    </p>
                  </div>
                );
              }
              if (m.kind === "typing") {
                return (
                  <div key={m.id} className="bubble-in-l flex w-fit items-center rounded-2xl rounded-bl-md bg-surface px-4 py-3 text-ink">
                    <span className="dots dots-lg" aria-label="Working on it"><span /><span /><span /></span>
                  </div>
                );
              }
              return <Reply key={m.id} m={m} starting={starting === m.requestId} disabled={starting !== null} onStart={() => void start(m.requestId)} onMore={() => { areaRef.current?.focus(); }} />;
            })}
            <div ref={endRef} />
          </div>
        )}

        <div className={`mt-4 flex items-end gap-2 rounded-[1.6rem] bg-surface p-2 text-ink shadow-xl transition ${focused ? "ring-2 ring-gold" : ""}`}>
          <textarea
            ref={areaRef} value={text} rows={1} maxLength={5000} aria-label="Describe what you need done"
            onChange={(e) => setText(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={onKey}
            placeholder={chatting ? "Add more detail or ask something else" : typed ? `${typed}|` : "Describe the job"}
            className="max-h-[132px] min-h-[48px] w-full resize-none bg-transparent px-3 py-3 text-base leading-snug placeholder:text-ink/40 focus:outline-none"
          />
          {canSpeak && (
            <button
              type="button" onClick={toggleMic} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Speak your request"}
              className={`relative grid h-12 w-12 shrink-0 place-items-center rounded-full transition ${listening ? "bg-alarm text-white mic-live" : "text-ink/60 hover:bg-brand/10 hover:text-ink"}`}
            >
              <MicIcon />
            </button>
          )}
          <SendButton ready={ready} busy={busy} onSend={() => void send(text)} />
        </div>

        {!chatting && (
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.slice(0, 4).map((ex) => (
              <button key={ex} type="button" onClick={() => { setText(ex); areaRef.current?.focus(); }} className="rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-sm transition hover:bg-white/20 active:scale-95">{ex}</button>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-white/55">
          {text.length > 4500 ? `${5000 - text.length} characters left. ` : ""}Nothing starts until you accept. Suggestions here come from simple rules, not from an AI.
        </p>
      </div>
    </section>
  );
}

function Reply({ m, starting, disabled, onStart, onMore }: { m: Extract<Msg, { role: "bot"; kind: "reply" }>; starting: boolean; disabled: boolean; onStart: () => void; onMore: () => void }) {
  const { u } = m;
  const info = PATH_INFO[u.path];
  const riskNote = u.top ? RISK_NOTE[u.top.risk] : null;
  return (
    <div className="bubble-in-l max-w-full space-y-3 rounded-2xl rounded-bl-md bg-surface p-4 text-ink shadow-lg sm:max-w-[92%]">
      {u.emergency && (
        <div role="alert" className="flex gap-2.5 rounded-xl border border-alarm/50 bg-alarm/10 p-3 text-sm text-alarm">
          <WarnIcon className="mt-0.5 h-5 w-5 shrink-0" />
          <p><span className="font-semibold">Possible {u.emergency.kind}. </span>{EMERGENCY_NOTE}</p>
        </div>
      )}

      {u.top ? (
        <>
          <p className="text-sm text-ink/70">Here is how I read that</p>
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand pop-in"><CategoryIcon id={u.top.icon} className="h-6 w-6" /></span>
            <div className="min-w-0">
              <p className="font-semibold leading-tight">{u.top.name}</p>
              <p className="text-xs text-ink/60">{u.top.blurb}</p>
            </div>
          </div>
          {u.matches.length > 1 && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink/60">
              Could also be:
              {u.matches.slice(1).map((x) => <span key={x.category.key} className="rounded-full border border-line px-2 py-0.5 font-semibold">{x.category.name}</span>)}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-ink/80">I could not tell which trade that is yet, so I saved it as a request. Add a few details like what is wrong, where, and when, and it will get clearer.</p>
      )}

      <div className="rounded-xl bg-brand/5 p-3 text-sm">
        <p className="flex items-center gap-1.5 font-semibold"><span className="h-2 w-2 rounded-full bg-gold" />{info.label}</p>
        <p className="mt-1 text-ink/70">{info.why}</p>
      </div>
      {riskNote && <p className="text-xs text-caution">{riskNote}</p>}

      {m.providers === null && <div className="flex gap-2 overflow-hidden"><div className="skeleton h-24 w-56 shrink-0 rounded-2xl" /><div className="skeleton h-24 w-56 shrink-0 rounded-2xl" /></div>}
      {m.providers && m.providers.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-semibold">People who could help</p>
          <div className="no-scrollbar -mx-1 flex snap-x gap-2.5 overflow-x-auto px-1 pb-1">
            {m.providers.map((p) => <ProviderCard key={p.id} p={p} compact />)}
          </div>
          <p className="mt-1.5 text-[11px] text-ink/50">Matched by name and headline. Distance and availability are not part of the directory yet.</p>
        </div>
      )}
      {m.providers && m.providers.length === 0 && u.top && (
        <p className="text-sm text-ink/60">No one in the directory matches this yet. You can still start the project and invite people later.</p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="gold" busy={starting} disabled={disabled} onClick={onStart}>Start project</Button>
        <Button variant="quiet" onClick={onMore}>Add detail</Button>
        {u.top && <Link to={`/find?q=${encodeURIComponent(u.top.name)}`} className="px-2 text-sm font-semibold text-brand underline">See more people</Link>}
      </div>
    </div>
  );
}
