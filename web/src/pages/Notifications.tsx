import { Link } from "react-router-dom";
import { Button, EmptyState, Note, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import type { NotificationRow } from "../lib/types";
import { useLoad } from "../lib/useLoad";

// Wording lives here, keyed by the machine `kind`, so it can be translated per user language later (PRD §113).
const TEXT: Record<string, string> = {
  "task.invited": "You were invited to quote on a task",
  "quote.submitted": "A provider sent a quote",
  "quote.accepted": "Your quote was accepted",
  "message.received": "You have a new message",
  "change.proposed": "A change was proposed",
  "change.accepted": "A change was accepted",
  "change.rejected": "A change was rejected",
  "review.received": "You received a review",
};

function target(n: NotificationRow): string {
  const pid = typeof n.payload.projectId === "string" ? n.payload.projectId : null;
  // A provider is not a project member until a quote is accepted, so their invitations and pre-award messages live on Profile.
  if (n.kind === "task.invited" || n.kind === "review.received" || (n.kind === "message.received" && n.payload.audience === "provider")) return "/profile";
  return pid ? `/projects/${pid}` : "/";
}

export default function Notifications() {
  const inbox = useLoad(() => api<{ notifications: NotificationRow[]; unread: number }>("GET", "/notifications"));
  const list = inbox.data?.notifications ?? [];

  async function readAll() {
    await api("POST", "/notifications/read-all", {});
    inbox.reload();
    window.dispatchEvent(new Event("lp:notifications"));
  }
  async function readOne(id: string) {
    try { await api("POST", `/notifications/${id}/read`, {}); window.dispatchEvent(new Event("lp:notifications")); } catch { /* the link still opens */ }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Notifications</h1>
        {(inbox.data?.unread ?? 0) > 0 && <Button variant="quiet" onClick={() => void readAll()}>Mark all read</Button>}
      </div>
      {inbox.error && <Note>{inbox.error}</Note>}
      {inbox.loading && !inbox.data ? <Skeleton className="h-20" /> : list.length === 0 ? (
        <EmptyState title="Nothing yet" hint="Invitations, quotes, messages and changes show up here." />
      ) : (
        <ul className="space-y-2">
          {list.map((n) => (
            <li key={n.id}>
              <Link to={target(n)} onClick={() => void readOne(n.id)} className={`block rounded-xl border p-3 ${n.readAt ? "border-line bg-surface" : "border-brand/40 bg-brand/5"}`}>
                <p className={`text-sm ${n.readAt ? "" : "font-semibold"}`}>{TEXT[n.kind] ?? "Something changed"}{typeof n.payload.title === "string" ? `: ${n.payload.title}` : ""}</p>
                <p className="mt-0.5 text-xs text-ink/60">{new Date(n.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
