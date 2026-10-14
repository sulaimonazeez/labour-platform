import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { toMinor } from "../lib/money";
import { useToast } from "../lib/toast";
import { Button, Note } from "./ui";

type Line = { kind: "labour" | "transport" | "materials"; label: string };
const LINES: Line[] = [
  { kind: "labour", label: "Labour (required)" },
  { kind: "materials", label: "Materials" },
  { kind: "transport", label: "Transport" },
];

/** A provider's quote on an invited task. The server computes totals; we only send line prices. */
export function QuoteForm({ taskId, currency, onSent }: { taskId: string; currency: string; onSent: () => void }) {
  const toast = useToast();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const lines: { kind: string; description: string; unitPriceMinor: number }[] = [];
    for (const l of LINES) {
      const raw = (amounts[l.kind] ?? "").trim();
      if (!raw) { if (l.kind === "labour") { setError("Enter your labour price"); return; } continue; }
      const minor = toMinor(raw, currency);
      if (minor === null) { setError(`"${raw}" is not a valid amount`); return; }
      if (minor > 0) lines.push({ kind: l.kind, description: l.label.replace(" (required)", ""), unitPriceMinor: minor });
    }
    if (lines.length === 0) { setError("Enter at least one price above zero"); return; }
    setBusy(true);
    try {
      const created = await api<{ quote: { id: string } }>("POST", `/tasks/${taskId}/quotes`, {
        currency, lines,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(exclusions.trim() ? { exclusions: exclusions.trim() } : {}),
      });
      await api("POST", `/quotes/${created.quote.id}/submit`, {});
      toast.success("Quote sent");
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the quote");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded-xl border border-line bg-surface px-3 py-2 text-base focus:border-brand";
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-line bg-paper p-3">
      <p className="text-sm font-semibold">Your quote ({currency})</p>
      {LINES.map((l) => (
        <label key={l.kind} className="block text-sm"><span className="mb-1 block">{l.label}</span>
          <input className={field} inputMode="decimal" value={amounts[l.kind] ?? ""} placeholder="0.00"
            onChange={(e) => setAmounts({ ...amounts, [l.kind]: e.target.value })} />
        </label>
      ))}
      <label className="block text-sm"><span className="mb-1 block">What is included (optional)</span>
        <textarea className={field} rows={2} maxLength={3000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <label className="block text-sm"><span className="mb-1 block">What is not included (optional)</span>
        <textarea className={field} rows={2} maxLength={3000} value={exclusions} onChange={(e) => setExclusions(e.target.value)} /></label>
      {error && <Note>{error}</Note>}
      <Button type="submit" variant="gold" busy={busy}>Send quote</Button>
    </form>
  );
}
