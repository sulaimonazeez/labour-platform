import { useState } from "react";
import { Card, Row, SimpleForm, Tabs, dt, useRun } from "../components/kit";
import { Button, EmptyState, Pill, Skeleton } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { formatMoney, toMinor } from "../lib/money";
import { useLoad } from "../lib/useLoad";

// PRD §13, §51, §123: sell products, fulfil orders, answer warranty claims, quote materials. Orders never share a payment with services.
type Merchant = { id: string; displayName: string; description: string | null };
type Product = { id: string; sku: string; name: string; priceMinor: number; currency: string; stock: number | null; warrantyMonths: number; isActive: boolean };
type Order = { id: string; status: string; paymentState: string; currency: string; totalMinor: number; createdAt: string };
type Open = { id: string; specification: string; quantity: number; status: string; myQuote: { p: number; c: string } | null };
type Claim = { id: string; description: string; status: string; warrantyKind: string; createdAt: string };

export default function MerchantPage() {
  const me = useLoad(() => api<{ merchant: Merchant | null }>("GET", "/merchants/me"));
  const [tab, setTab] = useState<"products" | "orders" | "requests" | "claims">("products");
  if (me.loading && !me.data) return <Skeleton className="h-40" />;
  if (!me.data?.merchant) return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Sell products</h1>
      <EmptyState title="You are not a merchant yet" hint="Create a merchant profile to list products, receive orders and quote materials for projects." />
      <Card title="Create your merchant profile"><SimpleForm submit="Create" fields={[{ name: "displayName", label: "Shop name", required: true, maxLength: 160 }, { name: "description", label: "About", type: "textarea", maxLength: 2000 }]} onSubmit={async (v) => { await api("POST", "/merchants", v); me.reload(); }} /></Card>
    </div>
  );
  return (
    <div className="space-y-5">
      <header><h1 className="text-3xl font-bold">{me.data.merchant.displayName}</h1><p className="text-sm text-ink/60">Your shop</p></header>
      <Tabs tabs={[{ id: "products", label: "Products" }, { id: "orders", label: "Orders" }, { id: "requests", label: "Quote requests" }, { id: "claims", label: "Warranty claims" }]} value={tab} onChange={setTab} />
      {tab === "products" && <Products />}
      {tab === "orders" && <Orders />}
      {tab === "requests" && <Requests />}
      {tab === "claims" && <Claims />}
    </div>
  );
}

function Products() {
  const list = useLoad(() => api<{ products: Product[] }>("GET", "/merchants/me/products"));
  const { busy, run } = useRun();
  return (
    <div className="space-y-4">
      <Card title="Add a product" hint="Prices are saved in minor units of the currency, so enter the normal price and it is converted.">
        <SimpleForm columns={2} submit="Add product" fields={[{ name: "sku", label: "SKU", required: true, maxLength: 80 }, { name: "name", label: "Name", required: true, maxLength: 200 }, { name: "price", label: "Price", type: "number", required: true }, { name: "currency", label: "Currency", defaultValue: "NGN", required: true, maxLength: 3 }, { name: "stock", label: "Stock (empty = not tracked)", type: "number" }, { name: "warrantyMonths", label: "Warranty (months)", type: "number", defaultValue: "0" }, { name: "description", label: "Description", type: "textarea", maxLength: 3000 }]}
          onSubmit={async (v) => { const { price, ...rest } = v; const minor = toMinor(String(price), String(v.currency)); if (minor === null) throw new Error("Enter a valid price"); await api("POST", "/merchants/me/products", { ...rest, priceMinor: minor }); list.reload(); }} />
      </Card>
      {(list.data?.products.length ?? 0) === 0 ? <EmptyState title="No products" hint="Add your first product above." /> : <ul className="space-y-2">{list.data?.products.map((p) => (
        <Row key={p.id}><div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{p.name}</p><p className="text-xs text-ink/60">{p.sku} · {formatMoney(p.priceMinor, p.currency)} · {p.stock === null ? "stock not tracked" : `${p.stock} in stock`}{p.warrantyMonths ? ` · ${p.warrantyMonths} month warranty` : ""}</p></div><Pill value={p.isActive ? "active" : "hidden"} /></div>
          <div className="mt-2 flex gap-2"><Button variant="quiet" busy={busy === `t${p.id}`} onClick={() => void run(`t${p.id}`, () => api("PATCH", `/merchants/me/products/${p.id}`, { isActive: !p.isActive }), p.isActive ? "Hidden" : "Visible again", list.reload)}>{p.isActive ? "Hide" : "Show"}</Button>
            <Button variant="quiet" busy={busy === `s${p.id}`} onClick={() => { const n = window.prompt("New stock level (empty for not tracked)", p.stock === null ? "" : String(p.stock)); if (n !== null) void run(`s${p.id}`, () => api("PATCH", `/merchants/me/products/${p.id}`, { stock: n.trim() === "" ? null : Number(n) }), "Stock updated", list.reload); }}>Set stock</Button></div></Row>
      ))}</ul>}
    </div>
  );
}

function Orders() {
  const list = useLoad(() => api<{ orders: Order[] }>("GET", "/merchants/me/orders"));
  const { busy, run } = useRun();
  const next: Record<string, [string, string] | undefined> = { created: ["confirm", "Confirm order"], confirmed: ["ship", "Mark shipped"], shipped: ["deliver", "Mark delivered"] };
  if (list.loading && !list.data) return <Skeleton className="h-20" />;
  if ((list.data?.orders.length ?? 0) === 0) return <EmptyState title="No orders yet" hint="Orders for your products appear here." />;
  return (
    <ul className="space-y-2">{list.data?.orders.map((o) => (
      <Row key={o.id}><div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{formatMoney(o.totalMinor, o.currency)}</p><p className="text-xs text-ink/60">{dt(o.createdAt)} · payment {o.paymentState.replaceAll("_", " ")}</p></div><Pill value={o.status} /></div>
        <div className="mt-2 flex gap-2">{next[o.status] && <Button variant="gold" busy={busy === o.id} onClick={() => void run(o.id, () => api("POST", `/orders/${o.id}/${next[o.status]?.[0]}`, {}), "Updated", list.reload)}>{next[o.status]?.[1]}</Button>}{["created", "confirmed"].includes(o.status) && <Button variant="quiet" busy={busy === `c${o.id}`} onClick={() => { if (window.confirm("Cancel this order?")) void run(`c${o.id}`, () => api("POST", `/orders/${o.id}/cancel`, {}), "Cancelled", list.reload); }}>Cancel</Button>}</div></Row>
    ))}</ul>
  );
}

function Requests() {
  const list = useLoad(() => api<{ requests: Open[] }>("GET", "/procurement/open").catch((e) => { if (e instanceof ApiError) return { requests: [] as Open[] }; throw e; }));
  const [open, setOpen] = useState<string | null>(null);
  if (list.loading && !list.data) return <Skeleton className="h-20" />;
  if ((list.data?.requests.length ?? 0) === 0) return <EmptyState title="No open requests" hint="When a project asks for materials, you can quote here. You never see who is asking." />;
  return (
    <ul className="space-y-2">{list.data?.requests.map((r) => (
      <Row key={r.id}><p className="font-medium">{r.specification} <span className="text-ink/50">× {r.quantity}</span></p>
        {r.myQuote && <p className="mt-1 text-sm text-signal">Your quote: {formatMoney(r.myQuote.p, r.myQuote.c)} each</p>}
        {open === r.id ? <div className="mt-3"><SimpleForm columns={2} submit="Send quote" fields={[{ name: "price", label: "Price each", type: "number", required: true }, { name: "currency", label: "Currency", defaultValue: "NGN", required: true, maxLength: 3 }, { name: "leadDays", label: "Days to deliver", type: "number" }, { name: "note", label: "Note", maxLength: 1000 }]} onSubmit={async (v) => { const { price, ...rest } = v; const minor = toMinor(String(price), String(v.currency)); if (minor === null) throw new Error("Enter a valid price"); await api("POST", `/procurement/${r.id}/quotes`, { ...rest, unitPriceMinor: minor }); setOpen(null); list.reload(); }} secondary={<Button type="button" variant="quiet" onClick={() => setOpen(null)}>Cancel</Button>} /></div> : <Button className="mt-2" variant="quiet" onClick={() => setOpen(r.id)}>{r.myQuote ? "Change my quote" : "Quote"}</Button>}
      </Row>
    ))}</ul>
  );
}

function Claims() {
  const list = useLoad(() => api<{ claims: Claim[] }>("GET", "/warranties/claims/incoming"));
  const { busy, run } = useRun();
  if ((list.data?.claims.length ?? 0) === 0) return <EmptyState title="No warranty claims" hint="Claims against warranties you gave appear here." />;
  return (
    <ul className="space-y-2">{list.data?.claims.map((c) => (
      <Row key={c.id}><div className="flex items-start justify-between gap-2"><p className="text-sm">{c.description}</p><Pill value={c.status} /></div><p className="mt-1 text-xs text-ink/60">{c.warrantyKind} warranty · {dt(c.createdAt)}</p>
        {c.status === "open" && <div className="mt-2 flex gap-2">{(["accepted", "rejected"] as const).map((s) => <Button key={s} variant="quiet" busy={busy === c.id + s} onClick={() => void run(c.id + s, () => api("POST", `/warranties/claims/${c.id}/decide`, { status: s }), "Updated", list.reload)}>{s === "accepted" ? "Accept" : "Reject"}</Button>)}</div>}
        {c.status === "accepted" && <Button className="mt-2" variant="quiet" busy={busy === c.id + "r"} onClick={() => void run(c.id + "r", () => api("POST", `/warranties/claims/${c.id}/decide`, { status: "resolved" }), "Resolved", list.reload)}>Mark resolved</Button>}
      </Row>
    ))}</ul>
  );
}
