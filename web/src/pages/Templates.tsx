import { useState } from "react";
import { Card, Row, SimpleForm, TrustBadge, day, useRun } from "../components/kit";
import { Button, EmptyState, Pill, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useIsAdmin } from "../lib/useIsAdmin";
import { useLoad } from "../lib/useLoad";

// PRD §22-23: a library of validated processes. Every version records who wrote it, where it applies, when it takes effect and
// whether it is approved. Projects keep the version they were created with. Plans retrieve these before inventing anything.
type Tpl = { key: string; title: string; description: string | null; categoryKey: string | null; ownerKind: string; version: number; language: string; approvalState: string; sourceKind: string; marketCodes: string[]; regulations: string[]; effectiveFrom: string | null; mine: boolean };
const STARTER = JSON.stringify({ title: "My process", stages: [{ name: "Stage one", tasks: [{ key: "start", title: "First task", skills: [], materialResponsibility: "not_applicable", dependsOn: [], inspectionRequired: false }] }], assumptions: [], risks: [], materials: [], questionsForProfessional: [], questions: [{ id: "where", text: "Where is the work?" }] }, null, 2);

export default function Templates() {
  const { user } = useAuth();
  const isAdmin = useIsAdmin(user?.id);
  const { busy, run } = useRun();
  const [cat, setCat] = useState("");
  const list = useLoad(() => api<{ templates: Tpl[] }>("GET", `/templates${cat ? `?category=${encodeURIComponent(cat)}` : ""}`), [cat]);
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Template library</h1>
      <input value={cat} onChange={(e) => setCat(e.target.value.trim())} placeholder="Filter by service key, e.g. solar_installation" className="w-full rounded-xl border border-line bg-surface px-3 py-2.5" />
      {list.loading && !list.data ? <Skeleton className="h-24" /> : (list.data?.templates.length ?? 0) === 0 ? <EmptyState title="No templates" hint="Approved templates and your own appear here." /> : (
        <ul className="space-y-2">{list.data?.templates.map((t) => (
          <Row key={`${t.key}${t.version}`}>
            <div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{t.title} <span className="text-xs text-ink/50">v{t.version}</span></p><p className="text-xs text-ink/60">{t.categoryKey ?? "any service"} · {t.language} · {t.marketCodes.length ? t.marketCodes.join(", ") : "every market"}{t.effectiveFrom ? ` · from ${day(t.effectiveFrom)}` : ""}</p></div><Pill value={t.approvalState} /></div>
            {t.description && <p className="mt-1 text-sm text-ink/70">{t.description}</p>}
            <p className="mt-1.5"><TrustBadge labels={["professional_body", "verified_expert", "government"].includes(t.sourceKind) ? ["professionally_verified"] : []} /> <span className="text-xs text-ink/50">source: {t.sourceKind.replaceAll("_", " ")}</span></p>
            <div className="mt-2 flex flex-wrap gap-2">
              {t.mine && t.approvalState === "draft" && <Button variant="quiet" busy={busy === `s${t.key}${t.version}`} onClick={() => void run(`s${t.key}${t.version}`, () => api("POST", `/templates/${t.key}/versions/${t.version}/submit`, {}), "Sent for review", list.reload)}>Submit for review</Button>}
              {isAdmin && ["in_review", "draft"].includes(t.approvalState) && (["approved", "rejected"] as const).map((d) => <Button key={d} variant={d === "approved" ? "gold" : "quiet"} busy={busy === d + t.key + t.version} onClick={() => void run(d + t.key + t.version, () => api("POST", `/templates/${t.key}/versions/${t.version}/decide`, { decision: d, global: d === "approved" }), d === "approved" ? "Approved" : "Rejected", list.reload)}>{d === "approved" ? "Approve for everyone" : "Reject"}</Button>)}
            </div>
          </Row>
        ))}</ul>
      )}
      <Card title="Write a template" hint="The body is the plan shape. Draft templates are private until a platform admin approves them.">
        <SimpleForm columns={2} submit="Save draft" fields={[
          { name: "key", label: "Key", required: true, placeholder: "my_cleaning_process", hint: "lowercase letters, digits, underscores" }, { name: "title", label: "Title", required: true, maxLength: 200 },
          { name: "categoryKey", label: "For service", placeholder: "cleaning_residential", maxLength: 120 }, { name: "language", label: "Language", defaultValue: "en", maxLength: 12 },
          { name: "body", label: "Body (JSON)", type: "textarea", required: true, defaultValue: STARTER },
        ]} onSubmit={async (v) => { let body: unknown; try { body = JSON.parse(String(v.body)); } catch { throw new Error("The body is not valid JSON"); } await api("POST", "/templates", { ...v, body }); list.reload(); }} />
      </Card>
    </div>
  );
}
