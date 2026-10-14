import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";
import { useLoad } from "../lib/useLoad";
import { errText, dt } from "./kit";
import { GlobeIcon, MicIcon } from "./Icons";
import { SendButton } from "./SendButton";
import { Note, Skeleton } from "./ui";

// One chat per context (PRD §31-32): project, stage, task, quote, change request, milestone, dispute, order.
// The server decides who may read it; this component only renders what it is given. Originals are always one tap away (PRD §28).

export type ChatType = "project" | "stage" | "task" | "quote" | "change_request" | "milestone" | "dispute" | "merchant_order";

type Msg = {
  id: string; mine: boolean; senderName: string; createdAt: string;
  original: { text: string; language: string };
  display: { text: string; language: string; translated: boolean; provenance?: { provider: string; model: string | null; confidence: number | null; translatedAt: string } };
  needsConfirmation: boolean; confirmed: boolean; canTranslate: boolean; transcript: string | null;
};
type Thread = { consequential: boolean; viewer?: { language: string; autoTranslate: boolean; showOriginalByDefault: boolean }; messages: Msg[] };

type Rec = { lang: string; interimResults: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start: () => void; stop: () => void };
const speechCtor = (): (new () => Rec) | null => {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const LANG_NAMES = (() => { try { return new Intl.DisplayNames(["en"], { type: "language" }); } catch { return null; } })();
const langName = (c: string) => LANG_NAMES?.of(c) ?? c;

export function ContextChat({ type, id, title, placeholder = "Write a message", pollMs = 8000 }: { type: ChatType; id: string; title?: string; placeholder?: string; pollMs?: number }) {
  const toast = useToast();
  const thread = useLoad(() => api<Thread>("GET", `/conversations/${type}/${id}/messages`), [type, id]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [orig, setOrig] = useState<Set<string>>(new Set());
  const [listening, setListening] = useState(false);
  const recRef = useRef<Rec | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const canSpeak = typeof window !== "undefined" && speechCtor() !== null;
  const count = thread.data?.messages.length ?? 0;

  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === "visible") thread.reload(); }, pollMs);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs]);
  useEffect(() => { if (count > 0) { endRef.current?.scrollIntoView({ block: "nearest" }); void api("POST", `/conversations/${type}/${id}/read`, {}).catch(() => undefined); } }, [count, type, id]);
  useEffect(() => () => recRef.current?.stop(), []);

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api("POST", `/conversations/${type}/${id}/messages`, { text: body });
      setText("");
      thread.reload();
    } catch (e) { toast.error(errText(e)); }
    finally { setBusy(false); }
  }
  async function confirm(m: Msg) {
    try { await api("POST", `/conversations/messages/${m.id}/confirm`, {}); toast.success("Thanks, noted"); thread.reload(); } catch (e) { toast.error(errText(e)); }
  }
  async function translate(m: Msg) {
    try {
      const r = await api<{ available: boolean; note?: string }>("POST", `/conversations/messages/${m.id}/translate`, {});
      if (!r.available) toast.error(r.note ?? "Translation is not available right now");
      thread.reload();
    } catch (e) { toast.error(errText(e)); }
  }
  function mic() {
    if (listening) { recRef.current?.stop(); return; }
    const C = speechCtor();
    if (!C) return;
    const r = new C();
    r.lang = thread.data?.viewer?.language ?? "en";
    r.interimResults = false;
    r.onresult = (e) => { const said = Array.from(e.results).map((x) => x[0]?.transcript ?? "").join(" ").trim(); if (said) setText((t) => (t ? `${t} ${said}` : said)); };
    r.onend = () => setListening(false);
    r.onerror = () => { setListening(false); toast.error("Could not hear you. Check microphone access."); };
    recRef.current = r;
    setListening(true);
    r.start();
  }

  if (thread.loading && !thread.data) return <Skeleton className="h-32" />;
  if (thread.error && !thread.data) return <Note>{thread.error}</Note>;
  const d = thread.data as Thread;
  const showOrigDefault = d.viewer?.showOriginalByDefault ?? false;

  return (
    <div className="space-y-3">
      {title && <h3 className="font-semibold">{title}</h3>}
      {d.consequential && <p className="rounded-xl bg-gold/15 px-3 py-2 text-xs text-ink/80">This conversation can change scope or money. If a message was translated for you, confirm that you understood it.</p>}
      <div className="max-h-[26rem] space-y-2.5 overflow-y-auto pr-1" aria-live="polite">
        {d.messages.length === 0 && <p className="py-6 text-center text-sm text-ink/50">No messages yet. Say hello.</p>}
        {d.messages.map((m) => {
          const viewOrig = showOrigDefault !== orig.has(m.id);
          const shown = viewOrig ? m.original.text : m.display.text;
          return (
            <div key={m.id} className={`flex flex-col ${m.mine ? "items-end" : "items-start"}`}>
              <p className="mb-0.5 text-[11px] text-ink/50">{m.mine ? "You" : m.senderName} · {dt(m.createdAt)}</p>
              <div className={`${m.mine ? "rounded-br-md bg-brand text-onbrand" : "rounded-bl-md bg-brand/10"} max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2`}>{shown}</div>
              {m.transcript && <p className="mt-0.5 text-[11px] text-ink/50">Voice note transcript</p>}
              {m.display.translated && (
                <button
                  type="button" onClick={() => setOrig((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
                  title={m.display.provenance ? `Translated by ${m.display.provenance.provider}${m.display.provenance.model ? ` (${m.display.provenance.model})` : ""}${m.display.provenance.confidence !== null ? `, confidence ${Math.round(m.display.provenance.confidence * 100)}%` : ""}` : undefined}
                  className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-ink/55 hover:text-ink"
                >
                  <GlobeIcon className="h-3 w-3" />
                  {viewOrig ? `Original (${langName(m.original.language)}) · show translation` : `Translated from ${langName(m.original.language)} · view original`}
                </button>
              )}
              {m.canTranslate && <button type="button" onClick={() => void translate(m)} className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-brand underline"><GlobeIcon className="h-3 w-3" />Translate for me</button>}
              {m.needsConfirmation && <button type="button" onClick={() => void confirm(m)} className="mt-1.5 rounded-full border border-gold bg-gold/20 px-3 py-1 text-xs font-bold">Confirm I understood</button>}
              {m.mine && m.confirmed && <p className="mt-0.5 text-[11px] text-signal">Understood by the other person</p>}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-1.5">
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={4000} placeholder={placeholder} aria-label="Message"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer: fine)").matches) { e.preventDefault(); void send(); } }}
          className="max-h-32 min-h-[44px] w-full resize-none bg-transparent px-2.5 py-2.5 text-base focus:outline-none"
        />
        {canSpeak && <button type="button" onClick={mic} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Dictate"} className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${listening ? "mic-live bg-alarm text-white" : "text-ink/60 hover:bg-brand/10"}`}><MicIcon /></button>}
        <SendButton ready={text.trim().length > 0} busy={busy} onSend={() => void send()} />
      </div>
    </div>
  );
}
