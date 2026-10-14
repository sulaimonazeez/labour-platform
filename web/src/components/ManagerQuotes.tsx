import { useState } from "react";
import { api } from "../lib/api";
import { formatMoney } from "../lib/money";
import { useToast } from "../lib/toast";
import type { QuoteRow, TaskInvitationRow } from "../lib/types";
import { useLoad } from "../lib/useLoad";
import { Avatar } from "./ProviderCard";
import { TaskThread } from "./TaskThread";
import { Note, Pill, Skeleton } from "./ui";

/** Who was invited to quote on a task, what they quoted, and a thread with each. The owner accepts one quote here. */
export function ManagerQuotes({ taskId, refreshKey, onChanged }: { taskId: string; refreshKey: number; onChanged: () => void }) {
  const toast = useToast();
  const invs = useLoad(() => api<{ invitations: TaskInvitationRow[] }>("GET", `/tasks/${taskId}/invitations`), [taskId, refreshKey]);
  const quotes = useLoad(() => api<{ quotes: QuoteRow[] }>("GET", `/tasks/${taskId}/quotes`), [taskId, refreshKey]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const list = invs.data?.invitations ?? [];

  async function accept(q: QuoteRow) {
    setBusy(q.id);
    try {
      await api("POST", `/quotes/${q.id}/accept`, {});
      toast.success(`You accepted ${q.providerName}'s quote`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not accept the quote");
    } finally {
      setBusy(null);
    }
  }

  if (invs.loading && !invs.data) return <Skeleton className="mt-4 h-16" />;
  if (invs.error) return <div className="mt-4"><Note>{invs.error}</Note></div>;
  if (list.length === 0) return null;

  return (
    <div className="mt-6">
      <h3 className="font-semibold">Invited and quotes</h3>
      <ul className="mt-2 space-y-2">
        {list.map((i) => {
          const q = (quotes.data?.quotes ?? []).find((x) => x.providerProfileId === i.providerProfileId && x.latest);
          const isOpen = open === i.providerProfileId;
          return (
            <li key={i.providerProfileId} className="rounded-xl border border-line bg-surface p-3">
              <div className="flex items-center gap-3">
                <Avatar name={i.displayName} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold leading-tight">{i.displayName}</p>
                  <p className="mt-0.5"><Pill value={q ? q.status : i.status} /></p>
                </div>
                <button type="button" onClick={() => setOpen(isOpen ? null : i.providerProfileId)} aria-expanded={isOpen}
                  className="shrink-0 rounded-xl border border-line px-3 py-2 text-sm font-semibold hover:bg-brand/5">{isOpen ? "Close" : "Message"}</button>
              </div>
              {q?.latest && (
                <div className="mt-3 rounded-xl bg-brand/5 p-3 text-sm">
                  <p className="text-lg font-bold tabular-nums">{formatMoney(q.latest.totalMinor, q.latest.currency)}</p>
                  {q.latest.notes && <p className="mt-1 text-ink/70">Included: {q.latest.notes}</p>}
                  {q.latest.exclusions && <p className="mt-1 text-ink/70">Not included: {q.latest.exclusions}</p>}
                  {q.status === "submitted" && (
                    <button type="button" disabled={busy !== null} onClick={() => void accept(q)}
                      className="mt-3 rounded-xl bg-gold px-4 py-2 font-semibold text-ink disabled:opacity-60">{busy === q.id ? "Accepting..." : "Accept this quote"}</button>
                  )}
                </div>
              )}
              {isOpen && <div className="mt-3"><TaskThread taskId={taskId} provider={i.providerProfileId} /></div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
