import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, Row, SimpleForm, Tabs, day, useRun } from "../components/kit";
import { Button, EmptyState, Pill, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { useLoad } from "../lib/useLoad";

// PRD §82-86: what was installed, who serviced it, what is under warranty, and when it is next due. "Hire again" reuses all of it.
type Asset = { id: string; kind: string; name: string; model: string | null; serial: string | null; installedOn: string | null; nextServiceOn: string | null; locationNote: string | null };
type Warranty = { id: string; kind: string; assetId: string | null; grantor: string | null; startsOn: string; endsOn: string; active: boolean; terms: string | null };
const KINDS = ["building", "vehicle", "equipment", "hvac", "solar_system", "appliance", "lock", "machinery", "other"];

export default function Assets() {
  const [params] = useSearchParams();
  const projectId = params.get("project") ?? undefined;
  const nav = useNavigate();
  const { busy, run } = useRun();
  const [tab, setTab] = useState<"assets" | "due" | "warranties">("assets");
  const [open, setOpen] = useState<string | null>(null);
  const assets = useLoad(() => api<{ assets: Asset[] }>("GET", "/assets"));
  const due = useLoad(() => api<{ due: Asset[] }>("GET", "/assets/due?days=60"));
  const war = useLoad(() => api<{ warranties: Warranty[] }>("GET", "/warranties"));
  const detail = useLoad(() => (open ? api<{ history: { id: string; performedOn: string; summary: string }[]; warranties: Warranty[] }>("GET", `/assets/${open}`) : Promise.resolve(null)), [open]);
  const claimFor = useState<string | null>(null);
  const list = assets.data?.assets ?? [];

  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Assets and warranties</h1>
      <Tabs tabs={[{ id: "assets", label: "Assets" }, { id: "due", label: "Due for service", badge: due.data?.due.length }, { id: "warranties", label: "Warranties" }]} value={tab} onChange={setTab} />
      {tab === "assets" && (
        <>
          <Card title="Register an asset" hint="Anything installed or maintained: a solar system, an AC, a generator, a lock, a vehicle.">
            <SimpleForm columns={2} submit="Add asset" fields={[
              { name: "kind", label: "Kind", type: "select", options: KINDS.map((k) => ({ value: k, label: k.replaceAll("_", " ") })) }, { name: "name", label: "Name", required: true, maxLength: 200 },
              { name: "model", label: "Model", maxLength: 120 }, { name: "serial", label: "Serial number", maxLength: 120 }, { name: "installedOn", label: "Installed on", type: "date" }, { name: "nextServiceOn", label: "Next service due", type: "date" },
              { name: "locationNote", label: "Where it is", maxLength: 500 },
            ]} onSubmit={async (v) => { await api("POST", "/assets", { ...v, ...(projectId ? { projectId } : {}) }); assets.reload(); due.reload(); }} />
          </Card>
          {assets.loading && !assets.data ? <Skeleton className="h-20" /> : list.length === 0 ? <EmptyState title="No assets yet" hint="Register what you own so servicing and warranties follow it." /> : (
            <ul className="space-y-2">{list.map((a) => (
              <Row key={a.id}>
                <button type="button" className="flex w-full items-start justify-between gap-2 text-left" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  <span><span className="font-semibold">{a.name}</span><span className="ml-2 text-xs text-ink/50">{a.kind.replaceAll("_", " ")}{a.model ? ` · ${a.model}` : ""}</span><span className="block text-xs text-ink/60">{a.nextServiceOn ? `Next service ${day(a.nextServiceOn)}` : "No service date set"}</span></span>
                  <span className="text-xs font-semibold text-brand">{open === a.id ? "Close" : "Open"}</span>
                </button>
                {open === a.id && (
                  <div className="mt-3 space-y-3 border-t border-line pt-3">
                    <div className="flex flex-wrap gap-2"><Button variant="gold" busy={busy === `h${a.id}`} onClick={() => void run(`h${a.id}`, async () => { await api("POST", `/assets/${a.id}/hire-again`, {}); nav("/"); }, "Request created. Choose how to proceed from Home.")}>Hire again</Button></div>
                    <SimpleForm columns={2} submit="Record a service" fields={[{ name: "performedOn", label: "Done on", type: "date", required: true }, { name: "nextServiceOn", label: "Next due", type: "date" }, { name: "summary", label: "What was done", type: "textarea", required: true, maxLength: 2000 }]} onSubmit={async (v) => { await api("POST", `/assets/${a.id}/service`, v); detail.reload(); assets.reload(); due.reload(); }} />
                    <div><p className="text-sm font-semibold">Service history</p>{(detail.data?.history.length ?? 0) === 0 ? <p className="text-sm text-ink/60">None recorded.</p> : <ul className="mt-1 space-y-1 text-sm">{detail.data?.history.map((h) => <li key={h.id}><span className="font-medium">{day(h.performedOn)}</span> · {h.summary}</li>)}</ul>}</div>
                    <SimpleForm columns={2} submit="Add a warranty" fields={[{ name: "kind", label: "Kind", type: "select", options: ["workmanship", "manufacturer", "merchant", "platform"].map((k) => ({ value: k, label: k })) }, { name: "grantor", label: "Given by", maxLength: 200 }, { name: "startsOn", label: "Starts", type: "date", required: true }, { name: "endsOn", label: "Ends", type: "date", required: true }, { name: "terms", label: "Terms", type: "textarea", maxLength: 4000 }]} onSubmit={async (v) => { await api("POST", "/warranties", { ...v, assetId: a.id }); detail.reload(); war.reload(); }} />
                  </div>
                )}
              </Row>
            ))}</ul>
          )}
        </>
      )}
      {tab === "due" && ((due.data?.due.length ?? 0) === 0 ? <EmptyState title="Nothing due in 60 days" hint="Set a next service date on an asset and it will show here." /> : <ul className="space-y-2">{due.data?.due.map((a) => <Row key={a.id} className="flex items-center justify-between gap-2"><span><span className="font-semibold">{a.name}</span><span className="block text-xs text-ink/60">Due {day(a.nextServiceOn)}</span></span><Button variant="gold" busy={busy === `d${a.id}`} onClick={() => void run(`d${a.id}`, async () => { await api("POST", `/assets/${a.id}/hire-again`, {}); nav("/"); }, "Request created")}>Book service</Button></Row>)}</ul>)}
      {tab === "warranties" && ((war.data?.warranties.length ?? 0) === 0 ? <EmptyState title="No warranties" hint="Add one from an asset." /> : (
        <ul className="space-y-2">{war.data?.warranties.map((w) => (
          <Row key={w.id}><div className="flex items-start justify-between gap-2"><div><p className="font-semibold capitalize">{w.kind} warranty</p><p className="text-sm text-ink/60">{w.grantor ?? "Grantor not stated"} · {day(w.startsOn)} to {day(w.endsOn)}</p></div><Pill value={w.active ? "active" : "ended"} /></div>
            {w.active && (claimFor[0] === w.id ? <div className="mt-3"><SimpleForm submit="Send claim" fields={[{ name: "description", label: "What is wrong", type: "textarea", required: true, maxLength: 4000 }]} onSubmit={async (v) => { await api("POST", `/warranties/${w.id}/claims`, v); claimFor[1](null); }} secondary={<Button type="button" variant="quiet" onClick={() => claimFor[1](null)}>Cancel</Button>} /></div> : <Button className="mt-2" variant="quiet" onClick={() => claimFor[1](w.id)}>Make a claim</Button>)}
          </Row>
        ))}</ul>
      ))}
    </div>
  );
}
