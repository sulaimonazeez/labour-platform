import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, EmptyState, Note, Pill, Skeleton } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useToast } from "../lib/toast";
import type { ProjectDetail } from "../lib/types";
import { useLoad } from "../lib/useLoad";

type EvidenceRow = { id: string; kind: string; mimeType: string | null; sizeBytes: number | null; capturedAt: string | null; createdAt: string; url: string | null };
type UploadTarget = { method: "PUT"; url: string; headers: Record<string, string>; expiresInSeconds: number };

const MANAGER = ["project_owner", "project_manager"];
const KINDS = [
  { v: "photo_before", label: "Photo: before" }, { v: "photo_progress", label: "Photo: progress" }, { v: "photo_after", label: "Photo: after" },
  { v: "video", label: "Video" }, { v: "document", label: "Document" }, { v: "receipt", label: "Receipt" },
];

function guessKind(f: File, current: string): string {
  if (f.type.startsWith("video/")) return "video";
  if (f.type === "application/pdf") return current === "receipt" ? "receipt" : "document";
  return current.startsWith("photo_") || current === "receipt" ? current : "photo_progress";
}
async function sha256(f: File): Promise<string | undefined> {
  // Only for files up to 20 MB, and only where the browser allows it (needs https or localhost).
  if (f.size > 20 * 1024 * 1024 || !globalThis.crypto?.subtle) return undefined;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", await f.arrayBuffer()));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One task's work page (PRD §65-66): the provider starts, adds evidence and submits; the owner approves, sends back or completes. */
export default function TaskWork() {
  const { projectId = "", taskId = "" } = useParams();
  const toast = useToast();
  const detail = useLoad(() => api<ProjectDetail>("GET", `/projects/${projectId}`), [projectId]);
  const ev = useLoad(() => api<{ evidence: EvidenceRow[] }>("GET", `/tasks/${taskId}/evidence`), [taskId]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState("photo_progress");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [sendBack, setSendBack] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (detail.loading && !detail.data) return <Skeleton className="h-40" />;
  if (detail.error || !detail.data) return <Note>{detail.error ?? "Could not load this task"}</Note>;
  const task = detail.data.tasks.find((t) => t.id === taskId);
  if (!task) return <EmptyState title="Task not found" hint="It may have been removed, or you may not have access to it." />;
  const isManager = detail.data.roles.some((r) => MANAGER.includes(r));
  const items = ev.data?.evidence ?? [];
  const canAddEvidence = !isManager && (task.status === "accepted" || task.status === "in_progress");

  async function act(path: string, body: Record<string, unknown>, done: string) {
    setBusy(path); setError(null);
    try {
      await api("POST", `/tasks/${taskId}/${path}`, body);
      toast.success(done);
      setNote(""); setReason(""); setSendBack(false);
      detail.reload(); ev.reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "evidence_requirements_not_met") {
        const d = e.details as { have?: number; required?: number } | undefined;
        setError(d?.required !== undefined ? `This task needs ${d.required} item${d.required === 1 ? "" : "s"} of evidence and has ${d.have ?? 0}. Add more, then submit.` : e.message);
      } else setError(e instanceof Error ? e.message : "That did not work");
    } finally { setBusy(null); }
  }

  async function upload(file: File) {
    setBusy("upload"); setError(null);
    try {
      const k = guessKind(file, kind);
      const issued = await api<{ storagePath: string; upload: UploadTarget }>("POST", `/tasks/${taskId}/evidence/upload-url`, { kind: k, mimeType: file.type, sizeBytes: file.size });
      const put = await fetch(issued.upload.url, { method: issued.upload.method, headers: issued.upload.headers, body: file });
      if (!put.ok) throw new Error(`The upload did not finish (${put.status}). Check your connection and try again`);
      const hash = await sha256(file);
      const taken = new Date(file.lastModified);
      await api("POST", `/tasks/${taskId}/evidence`, {
        kind: k, storagePath: issued.storagePath, mimeType: file.type, sizeBytes: file.size,
        ...(hash ? { fileSha256: hash } : {}),
        ...(file.lastModified > 0 && taken.getTime() <= Date.now() ? { capturedAt: taken.toISOString() } : {}),
      });
      toast.success("Added");
      ev.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the file");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-6">
      <Link to={`/projects/${projectId}`} className="text-sm font-semibold text-brand underline">Back to project</Link>
      <header className="rounded-2xl border border-line bg-surface p-5">
        <p className="text-xs text-ink/60">{detail.data.project.title}</p>
        <h1 className="mt-1 text-2xl font-bold leading-tight">{task.title}</h1>
        {task.description && task.description !== task.title && <p className="mt-2 text-ink/70">{task.description}</p>}
        <p className="mt-3"><Pill value={task.status} /></p>
      </header>

      {error && <Note>{error}</Note>}

      {!isManager && task.status === "accepted" && (
        <section className="rounded-2xl border border-gold/60 bg-gold/10 p-5">
          <h2 className="text-lg font-semibold">Ready to begin?</h2>
          <p className="mt-1 text-sm text-ink/70">Tapping start tells the customer that work has begun.</p>
          <Button variant="gold" className="mt-4" busy={busy === "start"} disabled={busy !== null} onClick={() => void act("start", {}, "Work started")}>Start work</Button>
        </section>
      )}

      {!isManager && task.status === "submitted" && <Note>You submitted this work. The customer will approve it or ask for changes.</Note>}
      {!isManager && task.status === "approved" && <Note>The customer approved your work. They will mark it complete.</Note>}

      <section>
        <h2 className="text-xl font-semibold">Evidence</h2>
        {canAddEvidence && (
          <div className="mt-3 space-y-3 rounded-2xl border border-line bg-surface p-4">
            <label className="block text-sm"><span className="mb-1 block font-medium">What is it?</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-base">
                {KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
              </select></label>
            <input ref={fileRef} type="file" accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf" aria-label="Choose a photo, video or document"
              disabled={busy !== null} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
              className="block w-full text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-brand file:px-4 file:py-2 file:font-semibold file:text-onbrand" />
            {busy === "upload" && <p className="text-sm text-ink/70" role="status">Uploading. Keep this page open...</p>}
          </div>
        )}
        {ev.loading && !ev.data ? <Skeleton className="mt-3 h-16" /> : items.length === 0 ? (
          <p className="mt-3 text-sm text-ink/60">No evidence yet.</p>
        ) : (
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.map((x) => (
              <li key={x.id} className="overflow-hidden rounded-xl border border-line bg-surface">
                {x.url && x.mimeType?.startsWith("image/") ? <a href={x.url} target="_blank" rel="noreferrer"><img src={x.url} alt={x.kind.replaceAll("_", " ")} loading="lazy" className="h-28 w-full object-cover" /></a>
                  : x.url ? <a href={x.url} target="_blank" rel="noreferrer" className="flex h-28 items-center justify-center text-sm font-semibold text-brand underline">Open file</a>
                  : <div className="flex h-28 items-center justify-center text-xs text-ink/50">No preview</div>}
                <p className="px-2 py-1.5 text-xs text-ink/70">{x.kind.replaceAll("_", " ")}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!isManager && task.status === "in_progress" && (
        <section className="rounded-2xl border border-line bg-surface p-5">
          <h2 className="text-lg font-semibold">Finished?</h2>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} placeholder="A short note for the customer (optional)"
            className="mt-3 w-full rounded-xl border border-line bg-surface px-3 py-2 text-base focus:border-brand" />
          <Button className="mt-3" busy={busy === "submit"} disabled={busy !== null} onClick={() => void act("submit", note.trim() ? { note: note.trim() } : {}, "Submitted for approval")}>Submit for approval</Button>
        </section>
      )}

      {isManager && task.status === "submitted" && (
        <section className="rounded-2xl border border-gold/60 bg-gold/10 p-5">
          <h2 className="text-lg font-semibold">Review the work</h2>
          <p className="mt-1 text-sm text-ink/70">Check the evidence above, then approve it or send it back.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="gold" busy={busy === "approve"} disabled={busy !== null} onClick={() => void act("approve", {}, "Work approved")}>Approve</Button>
            <Button variant="quiet" disabled={busy !== null} onClick={() => setSendBack(!sendBack)}>Send back</Button>
          </div>
          {sendBack && (
            <div className="mt-3 space-y-2">
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} placeholder="What needs to change?"
                className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-base focus:border-brand" />
              <Button busy={busy === "request-changes"} disabled={busy !== null || reason.trim().length === 0} onClick={() => void act("request-changes", { reason: reason.trim() }, "Sent back to the provider")}>Send</Button>
            </div>
          )}
        </section>
      )}
      {isManager && task.status === "approved" && (
        <section className="rounded-2xl border border-gold/60 bg-gold/10 p-5">
          <h2 className="text-lg font-semibold">Approved</h2>
          <p className="mt-1 text-sm text-ink/70">Mark the task complete once everything is settled. You can then review the provider.</p>
          <Button variant="gold" className="mt-4" busy={busy === "complete"} disabled={busy !== null} onClick={() => void act("complete", {}, "Task completed")}>Mark complete</Button>
        </section>
      )}
    </div>
  );
}
