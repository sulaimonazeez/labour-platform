import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { ThreadMessage } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { Note, Skeleton } from "./ui";

/** The conversation between a project manager and one invited provider about one task. Refreshes every 10 seconds. */
export function TaskThread({ taskId, provider }: { taskId: string; provider?: string }) {
  const qs = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  const thread = useLoad(() => api<{ messages: ThreadMessage[] }>("GET", `/tasks/${taskId}/messages${qs}`), [taskId, provider]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const list = thread.data?.messages ?? [];

  useEffect(() => {
    const id = window.setInterval(() => thread.reload(), 10_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, provider]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [list.length]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/tasks/${taskId}/messages`, { text: t, ...(provider ? { provider } : {}) });
      setText("");
      thread.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-paper p-3">
      <div className="max-h-64 space-y-2 overflow-y-auto" aria-live="polite">
        {thread.loading && !thread.data ? <Skeleton className="h-10" /> : list.length === 0 ? (
          <p className="text-sm text-ink/60">No messages yet. Ask about price, timing or access to the site.</p>
        ) : list.map((m) => (
          <div key={m.id} className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.mine ? "bg-brand text-onbrand" : "border border-line bg-surface"}`}>
              {!m.mine && <p className="text-xs font-semibold opacity-70">{m.senderName}</p>}
              <p className="whitespace-pre-wrap break-words">{m.text}</p>
              <p className="mt-0.5 text-[10px] opacity-60">{new Date(m.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</p>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {thread.error && <div className="mt-2"><Note>{thread.error}</Note></div>}
      {error && <div className="mt-2"><Note>{error}</Note></div>}
      <form onSubmit={send} className="mt-2 flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} aria-label="Message" placeholder="Write a message"
          className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-base focus:border-brand" />
        <button type="submit" disabled={busy || !text.trim()} className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-onbrand disabled:opacity-50">Send</button>
      </form>
    </div>
  );
}
