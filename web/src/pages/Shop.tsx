import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, Row, Tabs, dt, useRun } from "../components/kit";
import { Button, EmptyState, Note, Pill, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { formatMoney } from "../lib/money";
import type { ProjectRow } from "../lib/types";
import { useLoad } from "../lib/useLoad";

// PRD §13, §123: buy on your own or for a project. A product order is its own order: its own payment, refund and warranty.
type Product = { id: string; sku: string; name: string; description: string | null; priceMinor: number; currency: string; stock: number | null; warrantyMonths: number; merchantId: string; merchantName: string };
type Order = { id: string; status: string; paymentState: string; currency: string; totalMinor: number; taxMinor: number; createdAt: string; merchantId: string };

export default function Shop() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<"browse" | "orders">("browse");
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [projectId, setProjectId] = useState(params.get("project") ?? "");
  const { busy, run } = useRun();
  const products = useLoad(() => api<{ products: Product[] }>("GET", `/products?q=${encodeURIComponent(q)}`), [q]);
  const projects = useLoad(() => api<{ projects: ProjectRow[] }>("GET", "/projects"));
  const orders = useLoad(() => api<{ orders: Order[] }>("GET", "/orders/mine"));
  const [receipt, setReceipt] = useState<{ totalMinor: number; taxMinor: number; currency: string } | null>(null);

  const all = products.data?.products ?? [];
  const inCart = Object.entries(cart).filter(([, n]) => n > 0).map(([id, n]) => ({ p: all.find((x) => x.id === id), n })).filter((x): x is { p: Product; n: number } => !!x.p);
  const merchant = inCart[0]?.p.merchantId;
  const subtotal = inCart.reduce((t, x) => t + x.p.priceMinor * x.n, 0);
  const cur = inCart[0]?.p.currency ?? "NGN";
  const add = (p: Product) => {
    if (merchant && p.merchantId !== merchant && !window.confirm("Your basket has another shop's items. Start a new basket?")) return;
    setCart((c) => ({ ...(merchant && p.merchantId !== merchant ? {} : c), [p.id]: ((merchant && p.merchantId !== merchant ? 0 : c[p.id]) ?? 0) + 1 }));
  };
  const manageable = (projects.data?.projects ?? []).filter((p) => p.roles.some((r) => ["project_owner", "project_manager", "procurement_officer"].includes(r)));

  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Shop</h1>
      <Tabs tabs={[{ id: "browse", label: "Browse" }, { id: "orders", label: "My orders" }]} value={tab} onChange={setTab} />
      {tab === "browse" && (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder="Search products" aria-label="Search products" className="w-full rounded-xl border border-line bg-surface px-3 py-3" />
          {products.loading && !products.data ? <Skeleton className="h-24" /> : all.length === 0 ? <EmptyState title="Nothing found" hint="Merchants list products here. Try another word." /> : (
            <ul className="grid gap-3 sm:grid-cols-2">{all.map((p) => (
              <li key={p.id} className="rounded-2xl border border-line bg-surface p-4"><p className="font-semibold">{p.name}</p><p className="text-xs text-ink/60">{p.merchantName}{p.warrantyMonths ? ` · ${p.warrantyMonths} month warranty` : ""}</p>{p.description && <p className="mt-1 line-clamp-2 text-sm text-ink/70">{p.description}</p>}
                <div className="mt-3 flex items-center justify-between"><span className="font-bold">{formatMoney(p.priceMinor, p.currency)}</span><Button variant="quiet" disabled={p.stock !== null && p.stock <= 0} onClick={() => add(p)}>{p.stock !== null && p.stock <= 0 ? "Out of stock" : "Add"}</Button></div></li>
            ))}</ul>
          )}
          {inCart.length > 0 && (
            <Card title="Your basket" hint={`From ${inCart[0].p.merchantName}`}>
              <ul className="space-y-1.5 text-sm">{inCart.map(({ p, n }) => <li key={p.id} className="flex items-center justify-between gap-2"><span>{p.name}</span><span className="flex items-center gap-2"><button type="button" aria-label="One fewer" className="h-7 w-7 rounded-full border border-line" onClick={() => setCart({ ...cart, [p.id]: Math.max(0, n - 1) })}>-</button>{n}<button type="button" aria-label="One more" className="h-7 w-7 rounded-full border border-line" onClick={() => setCart({ ...cart, [p.id]: n + 1 })}>+</button><span className="w-24 text-right font-semibold">{formatMoney(p.priceMinor * n, p.currency)}</span></span></li>)}</ul>
              <p className="mt-2 text-sm text-ink/70">Subtotal {formatMoney(subtotal, cur)}. Tax is added from your market's rules when you order.</p>
              {manageable.length > 0 && <label className="mt-3 block text-sm font-medium">For a project (optional)<select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 font-normal"><option value="">Just for me</option>{manageable.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
              <Button className="mt-3" variant="gold" busy={busy === "order"} onClick={() => void run("order", async () => { const r = await api<{ order: { totalMinor: number; taxMinor: number; currency: string } }>("POST", "/orders", { merchantId: merchant, items: inCart.map((x) => ({ productId: x.p.id, quantity: x.n })), ...(projectId ? { projectId } : {}) }); setReceipt(r.order); setCart({}); orders.reload(); products.reload(); }, "Order placed")}>Place order</Button>
            </Card>
          )}
          {receipt && <Note tone="info">Order placed: {formatMoney(receipt.totalMinor, receipt.currency)} including {formatMoney(receipt.taxMinor, receipt.currency)} tax. Payment for this order is arranged separately from any service payment. <button type="button" className="font-semibold underline" onClick={() => setTab("orders")}>See your orders</button></Note>}
        </>
      )}
      {tab === "orders" && ((orders.data?.orders.length ?? 0) === 0 ? <EmptyState title="No orders" hint="Your product orders appear here." /> : (
        <ul className="space-y-2">{orders.data?.orders.map((o) => (
          <Row key={o.id}><div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{formatMoney(o.totalMinor, o.currency)}</p><p className="text-xs text-ink/60">{dt(o.createdAt)} · payment {o.paymentState.replaceAll("_", " ")}</p></div><Pill value={o.status} /></div>
            <div className="mt-2 flex gap-2">{o.status === "delivered" && <Button variant="gold" busy={busy === o.id} onClick={() => void run(o.id, () => api("POST", `/orders/${o.id}/accept`, {}), "Accepted", orders.reload)}>Accept delivery</Button>}{["created", "confirmed"].includes(o.status) && <Button variant="quiet" busy={busy === `c${o.id}`} onClick={() => { if (window.confirm("Cancel this order?")) void run(`c${o.id}`, () => api("POST", `/orders/${o.id}/cancel`, {}), "Cancelled", orders.reload); }}>Cancel</Button>}</div></Row>
        ))}</ul>
      ))}
    </div>
  );
}
