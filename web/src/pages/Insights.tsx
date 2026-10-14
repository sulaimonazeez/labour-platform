import { Card, Stat } from "../components/kit";
import { Note, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { formatMoney } from "../lib/money";
import { useLoad } from "../lib/useLoad";

// PRD §120-121, §161: demand, supply, pricing and completion, aggregated and anonymous. Small groups are hidden by the server.
type Ins = { minimumGroupSize: number; demand: { key: string; month: string; n: number }[]; supply: { category: string; providers: number | null }[]; pricing: { category: string; currency: string; jobs: number; medianMinor: number; averageMinor: number }[]; completion: { assignments: number; completedShare: number } | null; note: string };

export default function Insights() {
  const r = useLoad(() => api<Ins>("GET", "/insights/market"));
  if (r.loading && !r.data) return <Skeleton className="h-40" />;
  if (!r.data) return <Note>{r.error ?? "Insights are for organisations."}</Note>;
  const d = r.data;
  const months = [...new Set(d.demand.map((x) => x.month))].sort();
  const keys = [...new Set(d.demand.map((x) => x.key))];
  const max = Math.max(1, ...d.demand.map((x) => x.n));
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Market insights</h1>
      <Note tone="info">{d.note} Minimum group size: {d.minimumGroupSize}.</Note>
      <Card title="Delivery">{d.completion ? <div className="grid grid-cols-2 gap-2"><Stat label="Jobs assigned" value={d.completion.assignments} /><Stat label="Completed" value={`${d.completion.completedShare}%`} /></div> : <p className="text-sm text-ink/60">Not enough data yet.</p>}</Card>
      <Card title="Demand by month" hint="Requests per service.">
        {d.demand.length === 0 ? <p className="text-sm text-ink/60">Not enough data to show without identifying anyone.</p> : (
          <div className="space-y-3">{keys.map((k) => <div key={k}><p className="mb-1 text-sm font-semibold capitalize">{k.replaceAll("_", " ")}</p><div className="flex items-end gap-1.5">{months.map((m) => { const n = d.demand.find((x) => x.key === k && x.month === m)?.n ?? 0; return <div key={m} className="flex flex-1 flex-col items-center gap-1" title={`${m}: ${n}`}><div className="w-full rounded-t bg-gold" style={{ height: `${Math.max(2, (n / max) * 64)}px` }} /><span className="text-[10px] text-ink/50">{m.slice(5)}</span></div>; })}</div></div>)}</div>
        )}
      </Card>
      <Card title="Providers per service">{d.supply.length === 0 ? <p className="text-sm text-ink/60">No data.</p> : <ul className="space-y-1.5 text-sm">{d.supply.map((s) => <li key={s.category} className="flex justify-between"><span className="capitalize">{s.category.replaceAll("_", " ")}</span><span className="font-semibold">{s.providers ?? "hidden"}</span></li>)}</ul>}</Card>
      <Card title="Typical prices" hint="Accepted quotes, per currency.">{d.pricing.length === 0 ? <p className="text-sm text-ink/60">Not enough completed jobs yet.</p> : <ul className="space-y-1.5 text-sm">{d.pricing.map((p, i) => <li key={i} className="flex justify-between gap-2"><span className="capitalize">{p.category.replaceAll("_", " ")} <span className="text-ink/50">({p.jobs} jobs)</span></span><span className="font-semibold">median {formatMoney(p.medianMinor, p.currency)}</span></li>)}</ul>}</Card>
    </div>
  );
}
