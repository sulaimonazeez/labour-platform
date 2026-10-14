import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, Row, SimpleForm, dt } from "../components/kit";
import { WarnIcon } from "../components/Icons";
import { EmptyState, Pill } from "../components/ui";
import { api } from "../lib/api";
import { EMERGENCY_NOTE } from "../lib/taxonomy";
import { useLoad } from "../lib/useLoad";

// PRD §79-80: safety incidents are reported here, not buried in chat. This is never a substitute for emergency services.
export default function Safety() {
  const [params] = useSearchParams();
  const projectId = params.get("project") ?? undefined;
  const mine = useLoad(() => api<{ incidents: { id: string; category: string; severity: string; status: string; description: string; createdAt: string }[] }>("GET", "/safety-incidents/mine"));
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Report a safety incident</h1>
      <div role="alert" className="flex gap-2.5 rounded-xl border border-alarm/50 bg-alarm/10 p-3 text-sm text-alarm"><WarnIcon className="mt-0.5 h-5 w-5 shrink-0" /><p>{EMERGENCY_NOTE}</p></div>
      {note && <div role="alert" className="rounded-xl border border-alarm/50 bg-alarm/10 p-3 text-sm font-semibold text-alarm">{note}</div>}
      <Card title="What happened" hint="Tell us after you are safe. A person reviews every report.">
        <SimpleForm columns={2} submit="Submit report" fields={[
          { name: "category", label: "Kind", type: "select", options: ["personal_injury", "property_damage", "electrical_hazard", "fire", "equipment_damage", "security_concern", "unsafe_site"].map((v) => ({ value: v, label: v.replaceAll("_", " ") })) },
          { name: "severity", label: "How serious", type: "select", defaultValue: "medium", options: ["low", "medium", "high", "critical"].map((v) => ({ value: v, label: v })) },
          { name: "occurredAt", label: "When", type: "datetime" },
          { name: "emergencyServicesContacted", label: "Emergency services have been contacted", type: "checkbox" },
          { name: "description", label: "Describe what happened", type: "textarea", required: true, maxLength: 4000 },
        ]} onSubmit={async (v) => { const r = await api<{ emergencyNote?: string }>("POST", "/safety-incidents", { ...v, ...(projectId ? { projectId } : {}) }); setNote(r.emergencyNote ?? null); mine.reload(); }} />
      </Card>
      <section>
        <h2 className="text-lg font-semibold">Your reports</h2>
        {(mine.data?.incidents.length ?? 0) === 0 ? <div className="mt-3"><EmptyState title="Nothing reported" hint="Reports you submit appear here." /></div> : (
          <ul className="mt-3 space-y-2">{mine.data?.incidents.map((i) => <Row key={i.id}><div className="flex items-center justify-between gap-2"><span className="font-semibold capitalize">{i.category.replaceAll("_", " ")} · {i.severity}</span><Pill value={i.status} /></div><p className="mt-1 text-sm text-ink/80">{i.description}</p><p className="mt-1 text-xs text-ink/50">{dt(i.createdAt)}</p></Row>)}</ul>
        )}
      </section>
    </div>
  );
}
