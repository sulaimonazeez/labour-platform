import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, Row, SimpleForm, Tabs, day, dt, useRun } from "../components/kit";
import { Button, EmptyState, Note, Pill, Skeleton } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useLoad } from "../lib/useLoad";

// PRD §41-43, §71-72, §118: your calendar, the hours you publish, and services that repeat. Times show in your zone.
type Booking = { id: string; status: string; startsAt: string; endsAt: string; taskTitle: string; projectTitle: string; projectId: string; projectTimezone: string };
type Win = { weekday: number; startMinute: number; endMinute: number };
type Recurring = { id: string; title: string; frequency: string; intervalCount: number; nextDueOn: string; isActive: boolean; currency: string };

const weekdayName = (i: number) => new Date(2024, 0, 7 + i).toLocaleDateString([], { weekday: "long" });
const toHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromHM = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

export default function Schedule() {
  const [tab, setTab] = useState<"bookings" | "hours" | "recurring">("bookings");
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Schedule</h1>
      <Tabs tabs={[{ id: "bookings", label: "My bookings" }, { id: "hours", label: "My hours" }, { id: "recurring", label: "Repeating services" }]} value={tab} onChange={setTab} />
      {tab === "bookings" && <Bookings />}
      {tab === "hours" && <Hours />}
      {tab === "recurring" && <Repeating />}
    </div>
  );
}

function Bookings() {
  const list = useLoad(() => api<{ bookings: Booking[] }>("GET", "/bookings/mine"));
  if (list.loading && !list.data) return <Skeleton className="h-24" />;
  const byDay = new Map<string, Booking[]>();
  for (const b of list.data?.bookings ?? []) { const k = day(b.startsAt); byDay.set(k, [...(byDay.get(k) ?? []), b]); }
  if (byDay.size === 0) return <EmptyState title="Nothing booked" hint="Bookings from your projects and jobs show up here." />;
  return (
    <div className="space-y-4">{[...byDay.entries()].map(([d, items]) => (
      <section key={d}><h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink/50">{d}</h2>
        <ul className="space-y-2">{items.map((b) => <Row key={b.id}><div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{b.taskTitle}</p><p className="text-sm text-ink/60">{new Date(b.startsAt).toLocaleTimeString([], { timeStyle: "short" })} to {new Date(b.endsAt).toLocaleTimeString([], { timeStyle: "short" })} · <Link className="underline" to={`/projects/${b.projectId}`}>{b.projectTitle}</Link></p></div><Pill value={b.status} /></div></Row>)}</ul>
      </section>
    ))}</div>
  );
}

function Hours() {
  const av = useLoad(() => api<{ windows: Win[]; exceptions: { id: string; startsAt: string; endsAt: string; reason: string | null }[] }>("GET", "/providers/me/availability").catch((e) => { if (e instanceof ApiError && e.status === 404) return null; throw e; }));
  const { busy, run } = useRun();
  const [draft, setDraft] = useState<Record<number, { on: boolean; start: string; end: string }> | null>(null);
  if (av.loading && av.data === undefined) return <Skeleton className="h-40" />;
  if (!av.data) return <Note tone="info">Hours are for providers. Create a provider profile from your Profile page first.</Note>;
  const rows = draft ?? Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => { const w = av.data?.windows.find((x) => x.weekday === d); return [d, { on: !!w, start: toHM(w?.startMinute ?? 480), end: toHM(w?.endMinute ?? 1020) }]; }));
  const set = (d: number, patch: Partial<{ on: boolean; start: string; end: string }>) => setDraft({ ...rows, [d]: { ...rows[d], ...patch } });
  const save = () => run("hours", () => api("PUT", "/providers/me/availability", { windows: Object.entries(rows).filter(([, r]) => r.on && fromHM(r.end) > fromHM(r.start)).map(([d, r]) => ({ weekday: Number(d), startMinute: fromHM(r.start), endMinute: fromHM(r.end) })) }), "Hours saved", av.reload);
  return (
    <div className="space-y-4">
      <Card title="Weekly hours" hint="Customers see these hours and anonymous busy blocks, never what is in your calendar.">
        <ul className="space-y-2">{[0, 1, 2, 3, 4, 5, 6].map((d) => (
          <li key={d} className="flex items-center gap-3"><label className="flex w-36 items-center gap-2 text-sm font-medium"><input type="checkbox" checked={rows[d].on} onChange={(e) => set(d, { on: e.target.checked })} className="h-5 w-5 accent-[rgb(var(--brand))]" />{weekdayName(d)}</label>
            <input type="time" value={rows[d].start} disabled={!rows[d].on} onChange={(e) => set(d, { start: e.target.value })} className="rounded-lg border border-line bg-surface px-2 py-1.5 disabled:opacity-40" /><span className="text-ink/50">to</span>
            <input type="time" value={rows[d].end} disabled={!rows[d].on} onChange={(e) => set(d, { end: e.target.value })} className="rounded-lg border border-line bg-surface px-2 py-1.5 disabled:opacity-40" /></li>
        ))}</ul>
        <Button className="mt-4" busy={busy === "hours"} onClick={() => void save()}>Save hours</Button>
      </Card>
      <Card title="Time off">
        <SimpleForm columns={2} submit="Block this time" fields={[{ name: "startsAt", label: "From", type: "datetime", required: true }, { name: "endsAt", label: "Until", type: "datetime", required: true }, { name: "reason", label: "Reason (private)", maxLength: 200 }]} onSubmit={async (v) => { await api("POST", "/providers/me/availability/exceptions", v); av.reload(); }} />
        <ul className="mt-3 space-y-2">{av.data.exceptions.map((x) => <Row key={x.id} className="flex items-center justify-between gap-2 text-sm"><span>{dt(x.startsAt)} to {dt(x.endsAt)}{x.reason ? ` · ${x.reason}` : ""}</span><Button variant="quiet" busy={busy === x.id} onClick={() => void run(x.id, () => api("DELETE", `/providers/me/availability/exceptions/${x.id}`), "Removed", av.reload)}>Remove</Button></Row>)}</ul>
      </Card>
      <Card title="Where you work" hint="Only an approximate point (about 1 km) is saved. It is used to rank you by distance.">
        <SimpleForm columns={2} submit="Save area" fields={[{ name: "lat", label: "Latitude", type: "number", required: true }, { name: "lng", label: "Longitude", type: "number", required: true }, { name: "serviceRadiusKm", label: "How far you travel (km)", type: "number" }]}
          onSubmit={async (v) => { await api("PUT", "/providers/me/location", v); }} secondary={"geolocation" in navigator ? <Button type="button" variant="quiet" onClick={() => navigator.geolocation.getCurrentPosition((p) => void api("PUT", "/providers/me/location", { lat: p.coords.latitude, lng: p.coords.longitude }).then(() => window.alert("Saved your approximate area")), () => window.alert("Could not get your location"))}>Use my location</Button> : undefined} />
      </Card>
    </div>
  );
}

function Repeating({ currency }: { currency?: string }) {
  const list = useLoad(() => api<{ recurring: Recurring[] }>("GET", "/recurring"));
  const { busy, run } = useRun();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-4">
      <Card title="Repeat a service" hint="Each time it falls due, a new project is created with the tasks you list. Good for servicing, cleaning and inspections.">
        <SimpleForm columns={2} submit="Start repeating" fields={[
          { name: "title", label: "What repeats", required: true, maxLength: 200 },
          { name: "frequency", label: "How often", type: "select", defaultValue: "monthly", options: ["daily", "weekly", "monthly", "quarterly", "annual"].map((v) => ({ value: v, label: v })) },
          { name: "intervalCount", label: "Every (number)", type: "number", defaultValue: "1" }, { name: "startsOn", label: "First due", type: "date", defaultValue: today, required: true },
          { name: "currency", label: "Currency", defaultValue: currency ?? "NGN", required: true, maxLength: 3 }, { name: "task", label: "First task", hint: "Add more tasks later from the project", maxLength: 200 },
        ]} onSubmit={async (v) => { const { task, ...rest } = v; await api("POST", "/recurring", { ...rest, taskTemplate: task ? [{ title: task }] : [] }); list.reload(); }} />
      </Card>
      {(list.data?.recurring.length ?? 0) === 0 ? <EmptyState title="Nothing repeats yet" hint="Set one up above." /> : (
        <ul className="space-y-2">{list.data?.recurring.map((r) => (
          <Row key={r.id}><div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{r.title}</p><p className="text-sm text-ink/60">Every {r.intervalCount > 1 ? `${r.intervalCount} ` : ""}{r.frequency} · next due {day(r.nextDueOn)}</p></div><Pill value={r.isActive ? "active" : "paused"} /></div>
            <div className="mt-2 flex gap-2"><Button variant="quiet" busy={busy === `p${r.id}`} onClick={() => void run(`p${r.id}`, () => api("POST", `/recurring/${r.id}/${r.isActive ? "pause" : "resume"}`, {}), r.isActive ? "Paused" : "Resumed", list.reload)}>{r.isActive ? "Pause" : "Resume"}</Button><Button variant="quiet" busy={busy === `g${r.id}`} onClick={() => void run(`g${r.id}`, () => api("POST", `/recurring/${r.id}/run-now`, {}), "Created the next project", list.reload)}>Create the next one now</Button></div></Row>
        ))}</ul>
      )}
    </div>
  );
}
