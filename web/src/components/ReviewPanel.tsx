import { useState } from "react";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";
import type { ReviewableProvider } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { Button, Note } from "./ui";

const DIMS = [
  { k: "workmanship", label: "Quality of work" },
  { k: "punctuality", label: "Turned up on time" },
  { k: "communication", label: "Communication" },
  { k: "professionalism", label: "Professionalism" },
  { k: "quoteAccuracy", label: "Quote matched the final price" },
] as const;

/** PRD §91: several dimensions, shown only for providers who completed work here. Renders nothing when there is nobody to review. */
export function ReviewPanel({ projectId }: { projectId: string }) {
  const toast = useToast();
  const list = useLoad(() => api<{ providers: ReviewableProvider[] }>("GET", `/projects/${projectId}/reviews`), [projectId]);
  const [target, setTarget] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const todo = (list.data?.providers ?? []).filter((p) => !p.reviewed);
  if (list.error || todo.length === 0) return null;

  async function send() {
    if (!target) return;
    if (Object.keys(scores).length === 0) return setError("Give at least one rating");
    setBusy(true); setError(null);
    try {
      await api("POST", `/projects/${projectId}/reviews`, { providerProfileId: target, ...scores, ...(comment.trim() ? { comment: comment.trim() } : {}) });
      toast.success("Thank you. Your review is saved");
      setTarget(null); setScores({}); setComment("");
      list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the review");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-lg font-semibold">Review the work</h2>
      <ul className="mt-3 space-y-3">
        {todo.map((p) => (
          <li key={p.providerProfileId}>
            <button type="button" onClick={() => { setTarget(target === p.providerProfileId ? null : p.providerProfileId); setError(null); }} aria-expanded={target === p.providerProfileId}
              className="rounded-xl border border-line px-3 py-2 text-sm font-semibold hover:bg-brand/5">Review {p.displayName}</button>
            {target === p.providerProfileId && (
              <div className="mt-3 space-y-3">
                {DIMS.map((d) => (
                  <div key={d.k} className="text-sm"><p className="mb-1">{d.label}</p>
                    <div role="group" aria-label={d.label} className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} type="button" aria-pressed={scores[d.k] === n} onClick={() => setScores({ ...scores, [d.k]: n })}
                          className={`h-9 w-9 rounded-lg border text-sm font-semibold ${scores[d.k] === n ? "border-brand bg-brand text-onbrand" : "border-line"}`}>{n}</button>
                      ))}
                    </div></div>
                ))}
                <textarea value={comment} maxLength={2000} rows={2} onChange={(e) => setComment(e.target.value)} placeholder="Anything others should know (optional)"
                  className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-base focus:border-brand" />
                {error && <Note>{error}</Note>}
                <Button busy={busy} onClick={() => void send()}>Save review</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
