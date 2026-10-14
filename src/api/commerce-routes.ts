import { and, asc, desc, eq, gt, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import {
  assetServiceHistory, assets, currencies, marketTaxRules, merchantOrderItems, merchantOrders, merchants, procurementQuotes, procurementRequests,
  products, projects, providerProfiles, requestCandidates, requests, serviceCategories, tasks, users, warrantyClaims, warranties, approvalRequests,
} from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { isPlatformAdmin } from "../authz/platform-admin";
import { PROJECT_MANAGERS, requireProjectRole } from "../authz/projects";
import { recordActivity } from "../lib/activity";
import { runIdempotent } from "../lib/idempotency";
import { notify } from "../lib/notify";
import type { Executor } from "../db/types";
import { requiresApproval } from "./org-routes";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http";

// PRD §13, §51 (commerce is linked to labour but financially independent), §63-64 (materials, procurement),
// §82-86 (warranties, aftercare, assets, repeat hire), §123 (marketplace commerce stays modular).

const notFound = () => new ApiError(404, "not_found", "Not found");
const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do this");
const PROCUREMENT_ROLES = [...PROJECT_MANAGERS, "procurement_officer"] as const;

async function myMerchant(ex: Executor, userId: string) {
  const [m] = await ex.select().from(merchants).where(eq(merchants.ownerUserId, userId)).limit(1);
  if (!m) throw notFound();
  return m;
}

/** Tax is a configuration layer (PRD §124): rules are read from the market, never hard-coded. */
export async function productTax(ex: Executor, marketId: string | null, subtotalMinor: number) {
  if (!marketId) return { taxMinor: 0, breakdown: [] as { code: string; rateBps: number; amountMinor: number }[] };
  const today = new Date().toISOString().slice(0, 10);
  const rules = await ex.select().from(marketTaxRules).where(and(eq(marketTaxRules.marketId, marketId), lte(marketTaxRules.effectiveFrom, today), or(isNull(marketTaxRules.effectiveTo), gt(marketTaxRules.effectiveTo, today))));
  const applies = rules.filter((r) => { const k = (r.appliesTo as { kind?: string }).kind; return !k || k === "all" || k === "product"; });
  const breakdown = applies.map((r) => ({ code: r.taxCode, rateBps: r.rateBps, amountMinor: Math.round((subtotalMinor * r.rateBps) / 10000) }));
  return { taxMinor: breakdown.reduce((n, b) => n + b.amountMinor, 0), breakdown };
}

// ── merchants and products ───────────────────────────────────────────────────
export const merchantRoutes = new Hono<AuthEnv>();
merchantRoutes.use("*", requireAuth);
merchantRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ displayName: z.string().trim().min(1).max(160), description: z.string().trim().max(2000).optional(), organisationId: z.uuid().optional() }), raw);
  return runIdempotent(c, { scope: "merchants.create", userId, body: raw }, async (tx) => {
    const [exists] = await tx.select({ id: merchants.id }).from(merchants).where(eq(merchants.ownerUserId, userId)).limit(1);
    if (exists) throw new ApiError(409, "merchant_exists", "You already have a merchant profile");
    const [me] = await tx.select({ marketId: users.marketId }).from(users).where(eq(users.id, userId)).limit(1);
    const [m] = await tx.insert(merchants).values({ ownerUserId: userId, displayName: b.displayName, description: b.description ?? null, organisationId: b.organisationId ?? null, marketId: me?.marketId ?? null }).returning({ id: merchants.id });
    return { status: 201, body: { merchant: { id: m.id, displayName: b.displayName } } };
  });
});
merchantRoutes.get("/me", async (c) => c.json({ merchant: await db.select().from(merchants).where(eq(merchants.ownerUserId, c.get("auth").userId)).limit(1).then((r) => r[0] ?? null) }));

const productBody = z.strictObject({
  sku: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(200), description: z.string().trim().max(3000).optional(), categoryKey: z.string().trim().max(120).optional(),
  priceMinor: z.int().min(0), currency: z.string().trim().length(3), stock: z.int().min(0).optional(), warrantyMonths: z.int().min(0).max(240).default(0),
  attributes: z.record(z.string(), z.unknown()).default({}),
});
merchantRoutes.post("/me/products", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(productBody, raw);
  return runIdempotent(c, { scope: "products.create", userId, body: raw }, async (tx) => {
    const m = await myMerchant(tx, userId);
    const [cur] = await tx.select({ c: currencies.code }).from(currencies).where(eq(currencies.code, b.currency)).limit(1);
    if (!cur) throw new ApiError(400, "unknown_currency", "Unknown currency");
    const [p] = await tx.insert(products).values({ merchantId: m.id, sku: b.sku, name: b.name, description: b.description ?? null, categoryKey: b.categoryKey ?? null, priceMinor: b.priceMinor, currency: b.currency, stock: b.stock ?? null, warrantyMonths: b.warrantyMonths, attributes: b.attributes }).onConflictDoNothing().returning({ id: products.id });
    if (!p) throw new ApiError(409, "sku_exists", "You already have a product with this SKU");
    return { status: 201, body: { product: { id: p.id, sku: b.sku } } };
  });
});
const productPatch = z.strictObject({ name: z.string().trim().min(1).max(200).optional(), description: z.string().trim().max(3000).optional(), priceMinor: z.int().min(0).optional(), stock: z.int().min(0).nullable().optional(), warrantyMonths: z.int().min(0).max(240).optional(), isActive: z.boolean().optional() });
merchantRoutes.patch("/me/products/:id", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(productPatch, raw);
  if (Object.keys(b).length === 0) throw new ApiError(400, "nothing_to_update", "Send at least one field");
  return runIdempotent(c, { scope: "products.patch", userId, body: { id, raw } }, async (tx) => {
    const m = await myMerchant(tx, userId);
    const r = await tx.update(products).set(b).where(and(eq(products.id, id), eq(products.merchantId, m.id))).returning({ id: products.id });
    if (r.length === 0) throw notFound();
    return { status: 200, body: { updated: Object.keys(b) } };
  });
});
merchantRoutes.get("/me/products", async (c) => {
  const m = await myMerchant(db, c.get("auth").userId);
  return c.json({ products: await db.select().from(products).where(eq(products.merchantId, m.id)).orderBy(asc(products.name)) });
});
merchantRoutes.get("/me/orders", async (c) => {
  const m = await myMerchant(db, c.get("auth").userId);
  const rows = await db.select().from(merchantOrders).where(eq(merchantOrders.merchantId, m.id)).orderBy(desc(merchantOrders.createdAt)).limit(200);
  return c.json({ orders: rows });
});

export const productRoutes = new Hono<AuthEnv>();
productRoutes.use("*", requireAuth);
productRoutes.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  const cat = c.req.query("category");
  const mid = c.req.query("merchantId");
  const rows = await db.select({ p: products, merchant: merchants.displayName }).from(products).innerJoin(merchants, eq(merchants.id, products.merchantId))
    .where(and(eq(products.isActive, true), eq(merchants.isActive, true), q ? or(ilike(products.name, `%${q.replace(/[%_]/g, "")}%`), ilike(products.description, `%${q.replace(/[%_]/g, "")}%`)) : sql`true`, cat ? eq(products.categoryKey, cat) : sql`true`, mid ? eq(products.merchantId, uuidParam(mid)) : sql`true`))
    .orderBy(asc(products.priceMinor)).limit(60);
  return c.json({ products: rows.map((r) => ({ ...r.p, merchantName: r.merchant })) });
});

// ── orders (PRD §51): their own payment, refund, dispute and fulfilment state ─
export const orderRoutes = new Hono<AuthEnv>();
orderRoutes.use("*", requireAuth);
const orderBody = z.strictObject({
  merchantId: z.uuid(), items: z.array(z.strictObject({ productId: z.uuid(), quantity: z.int().min(1).max(1000) })).min(1).max(50),
  projectId: z.uuid().optional(), taskId: z.uuid().optional(), delivery: z.record(z.string(), z.unknown()).default({}),
});
orderRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(orderBody, raw);
  return runIdempotent(c, { scope: "orders.create", userId, body: raw }, async (tx) => {
    if (b.projectId) await requireProjectRole(tx, b.projectId, userId, PROCUREMENT_ROLES);
    if (b.taskId) { const [t] = await tx.select({ p: tasks.projectId }).from(tasks).where(eq(tasks.id, b.taskId)).limit(1); if (!t || t.p !== b.projectId) throw new ApiError(400, "task_not_in_project", "The task must belong to the project"); }
    const [m] = await tx.select().from(merchants).where(and(eq(merchants.id, b.merchantId), eq(merchants.isActive, true))).limit(1);
    if (!m) throw notFound();
    const ids = b.items.map((i) => i.productId);
    const ps = await tx.select().from(products).where(and(inArray(products.id, ids), eq(products.merchantId, m.id), eq(products.isActive, true))).for("update");
    if (ps.length !== new Set(ids).size) throw new ApiError(400, "unknown_product", "Some products are not sold by this merchant");
    const currency = ps[0].currency;
    if (ps.some((p) => p.currency !== currency)) throw new ApiError(400, "mixed_currency", "One order cannot mix currencies");
    let subtotal = 0;
    const lines = b.items.map((i) => {
      const p = ps.find((x) => x.id === i.productId) as (typeof ps)[number];
      if (p.stock !== null && p.stock < i.quantity) throw new ApiError(409, "out_of_stock", `Not enough stock for ${p.name}`);
      const amount = p.priceMinor * i.quantity;
      subtotal += amount;
      return { p, quantity: i.quantity, amount };
    });
    for (const l of lines) if (l.p.stock !== null) await tx.update(products).set({ stock: l.p.stock - l.quantity }).where(eq(products.id, l.p.id));
    const [buyer] = await tx.select({ marketId: users.marketId }).from(users).where(eq(users.id, userId)).limit(1);
    const tax = await productTax(tx, buyer?.marketId ?? null, subtotal);
    const [o] = await tx.insert(merchantOrders).values({ buyerUserId: userId, merchantId: m.id, projectId: b.projectId ?? null, taskId: b.taskId ?? null, currency, subtotalMinor: subtotal, taxMinor: tax.taxMinor, totalMinor: subtotal + tax.taxMinor, taxBreakdown: tax.breakdown, delivery: b.delivery }).returning({ id: merchantOrders.id });
    await tx.insert(merchantOrderItems).values(lines.map((l) => ({ orderId: o.id, productId: l.p.id, name: l.p.name, quantity: l.quantity, unitPriceMinor: l.p.priceMinor, amountMinor: l.amount })));
    if (b.projectId) await recordActivity(tx, { projectId: b.projectId, actorUserId: userId, eventType: "order.created", subjectType: "merchant_order", subjectId: o.id, payload: { merchantId: m.id, totalMinor: subtotal + tax.taxMinor, currency } });
    await notify(tx, [m.ownerUserId], "order.created", { orderId: o.id, projectId: b.projectId ?? null }, userId);
    return { status: 201, body: { order: { id: o.id, status: "created", paymentState: "created", currency, subtotalMinor: subtotal, taxMinor: tax.taxMinor, totalMinor: subtotal + tax.taxMinor, taxBreakdown: tax.breakdown }, note: "Payment for this order is separate from any service payment and is collected through the payment orchestration layer." } };
  });
});
orderRoutes.get("/mine", async (c) => c.json({ orders: await db.select().from(merchantOrders).where(eq(merchantOrders.buyerUserId, c.get("auth").userId)).orderBy(desc(merchantOrders.createdAt)).limit(200) }));
orderRoutes.get("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const [r] = await db.select({ o: merchantOrders, owner: merchants.ownerUserId, merchant: merchants.displayName }).from(merchantOrders).innerJoin(merchants, eq(merchants.id, merchantOrders.merchantId)).where(eq(merchantOrders.id, id)).limit(1);
  if (!r || (r.o.buyerUserId !== userId && r.owner !== userId)) throw notFound();
  return c.json({ order: { ...r.o, merchantName: r.merchant }, items: await db.select().from(merchantOrderItems).where(eq(merchantOrderItems.orderId, id)) });
});
const NEXT: Record<string, { to: string; by: "merchant" | "buyer" | "either"; from: string[] }> = {
  confirm: { to: "confirmed", by: "merchant", from: ["created"] },
  ship: { to: "shipped", by: "merchant", from: ["confirmed"] },
  deliver: { to: "delivered", by: "merchant", from: ["shipped"] },
  accept: { to: "accepted", by: "buyer", from: ["delivered"] },
  cancel: { to: "cancelled", by: "either", from: ["created", "confirmed"] },
};
for (const [action, rule] of Object.entries(NEXT)) {
  orderRoutes.post(`/:id/${action}`, async (c) => {
    const userId = c.get("auth").userId;
    const id = uuidParam(c.req.param("id"));
    return runIdempotent(c, { scope: `orders.${action}`, userId, body: { id } }, async (tx) => {
      const [r] = await tx.select({ o: merchantOrders, owner: merchants.ownerUserId }).from(merchantOrders).innerJoin(merchants, eq(merchants.id, merchantOrders.merchantId)).where(eq(merchantOrders.id, id)).limit(1).for("update");
      if (!r || (r.o.buyerUserId !== userId && r.owner !== userId)) throw notFound();
      const isMerchant = r.owner === userId;
      if (rule.by === "merchant" && !isMerchant) throw forbidden();
      if (rule.by === "buyer" && r.o.buyerUserId !== userId) throw forbidden();
      if (!rule.from.includes(r.o.status)) throw new ApiError(409, "invalid_transition", `An order that is ${r.o.status} cannot be ${rule.to}`);
      if (rule.to === "cancelled") {
        for (const it of await tx.select().from(merchantOrderItems).where(eq(merchantOrderItems.orderId, id))) {
          if (it.productId) await tx.update(products).set({ stock: sql`case when ${products.stock} is null then null else ${products.stock} + ${it.quantity} end` }).where(eq(products.id, it.productId));
        }
      }
      await tx.update(merchantOrders).set({ status: rule.to }).where(eq(merchantOrders.id, id));
      if (r.o.projectId) await recordActivity(tx, { projectId: r.o.projectId, actorUserId: userId, eventType: `order.${rule.to}`, subjectType: "merchant_order", subjectId: id, payload: {} });
      await notify(tx, [isMerchant ? r.o.buyerUserId : r.owner], `order.${rule.to}`, { orderId: id, projectId: r.o.projectId }, userId);
      return { status: 200, body: { order: { id, status: rule.to } } };
    });
  });
}

// ── procurement (PRD §64): need -> spec -> quotes -> approval -> order -> delivery -> acceptance ──
export const procurementProjectRoutes = new Hono<AuthEnv>();
procurementProjectRoutes.use("*", requireAuth);
procurementProjectRoutes.post("/:id/procurement", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ specification: z.string().trim().min(3).max(4000), quantity: z.int().min(1).max(100000).default(1), taskId: z.uuid().optional() }), raw);
  return runIdempotent(c, { scope: "procurement.create", userId, body: { projectId, raw } }, async (tx) => {
    await requireProjectRole(tx, projectId, userId, PROCUREMENT_ROLES);
    if (b.taskId) { const [t] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, b.taskId), eq(tasks.projectId, projectId))).limit(1); if (!t) throw notFound(); }
    const [r] = await tx.insert(procurementRequests).values({ projectId, taskId: b.taskId ?? null, requestedByUserId: userId, specification: b.specification, quantity: b.quantity }).returning({ id: procurementRequests.id });
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: "procurement.requested", subjectType: "procurement_request", subjectId: r.id, payload: { quantity: b.quantity } });
    return { status: 201, body: { procurement: { id: r.id, status: "need_identified" } } };
  });
});
procurementProjectRoutes.get("/:id/procurement", async (c) => {
  const projectId = uuidParam(c.req.param("id"));
  await requireProjectRole(db, projectId, c.get("auth").userId, PROCUREMENT_ROLES);
  const rows = await db.select().from(procurementRequests).where(eq(procurementRequests.projectId, projectId)).orderBy(desc(procurementRequests.createdAt));
  const out = [];
  for (const r of rows) {
    const qs = await db.select({ q: procurementQuotes, merchant: merchants.displayName }).from(procurementQuotes).innerJoin(merchants, eq(merchants.id, procurementQuotes.merchantId)).where(eq(procurementQuotes.procurementRequestId, r.id));
    out.push({ ...r, quotes: qs.map((x) => ({ ...x.q, merchantName: x.merchant })) });
  }
  return c.json({ procurement: out });
});

export const procurementRoutes = new Hono<AuthEnv>();
procurementRoutes.use("*", requireAuth);
// Merchants see what is being asked for, never who is asking or which project it is (privacy).
procurementRoutes.get("/open", async (c) => {
  const m = await myMerchant(db, c.get("auth").userId);
  const rows = await db.select({ id: procurementRequests.id, specification: procurementRequests.specification, quantity: procurementRequests.quantity, status: procurementRequests.status, createdAt: procurementRequests.createdAt })
    .from(procurementRequests).where(inArray(procurementRequests.status, ["need_identified", "quoting"])).orderBy(desc(procurementRequests.createdAt)).limit(100);
  const mine = rows.length > 0 ? await db.select({ r: procurementQuotes.procurementRequestId, p: procurementQuotes.unitPriceMinor, c: procurementQuotes.currency }).from(procurementQuotes).where(and(eq(procurementQuotes.merchantId, m.id), inArray(procurementQuotes.procurementRequestId, rows.map((r) => r.id)))) : [];
  return c.json({ requests: rows.map((r) => ({ ...r, myQuote: mine.find((q) => q.r === r.id) ?? null })) });
});
procurementRoutes.post("/:id/quotes", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ productId: z.uuid().optional(), unitPriceMinor: z.int().min(0), currency: z.string().trim().length(3), leadDays: z.int().min(0).max(365).optional(), note: z.string().trim().max(1000).optional() }), raw);
  return runIdempotent(c, { scope: "procurement.quote", userId, body: { id, raw } }, async (tx) => {
    const m = await myMerchant(tx, userId);
    const [r] = await tx.select().from(procurementRequests).where(eq(procurementRequests.id, id)).limit(1).for("update");
    if (!r || !["need_identified", "quoting"].includes(r.status)) throw new ApiError(409, "not_open", "This request is not collecting quotes");
    await tx.insert(procurementQuotes).values({ procurementRequestId: id, merchantId: m.id, productId: b.productId ?? null, unitPriceMinor: b.unitPriceMinor, currency: b.currency, leadDays: b.leadDays ?? null, note: b.note ?? null })
      .onConflictDoUpdate({ target: [procurementQuotes.procurementRequestId, procurementQuotes.merchantId], set: { productId: b.productId ?? null, unitPriceMinor: b.unitPriceMinor, currency: b.currency, leadDays: b.leadDays ?? null, note: b.note ?? null, status: "submitted" } });
    await tx.update(procurementRequests).set({ status: "quoting" }).where(eq(procurementRequests.id, id));
    await recordActivity(tx, { projectId: r.projectId, actorUserId: userId, eventType: "procurement.quoted", subjectType: "procurement_request", subjectId: id, payload: { merchantId: m.id } });
    return { status: 201, body: { quote: { procurementRequestId: id, merchantId: m.id } } };
  });
});
procurementRoutes.post("/:id/select", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const b = parseOrThrow(z.strictObject({ quoteId: z.uuid() }), await readJson(c));
  return runIdempotent(c, { scope: "procurement.select", userId, body: { id, b } }, async (tx) => {
    const [r] = await tx.select().from(procurementRequests).where(eq(procurementRequests.id, id)).limit(1).for("update");
    if (!r) throw notFound();
    await requireProjectRole(tx, r.projectId, userId, PROCUREMENT_ROLES);
    if (r.status !== "quoting") throw new ApiError(409, "not_quoting", `A ${r.status} request cannot select a quote`);
    const [q] = await tx.select().from(procurementQuotes).where(and(eq(procurementQuotes.id, b.quoteId), eq(procurementQuotes.procurementRequestId, id))).limit(1);
    if (!q) throw notFound();
    const total = q.unitPriceMinor * r.quantity;
    // Approval gate (PRD §115): if the project's organisation has a procurement policy covering this amount, it must be approved first.
    const [proj] = await tx.select({ org: projects.organisationId }).from(projects).where(eq(projects.id, r.projectId)).limit(1);
    if (proj?.org) {
      const policy = await requiresApproval(tx, proj.org, "procurement", total, q.currency);
      if (policy) {
        const [ok] = await tx.select({ s: approvalRequests.status }).from(approvalRequests).where(and(eq(approvalRequests.subjectType, "procurement"), eq(approvalRequests.subjectId, id), eq(approvalRequests.status, "approved"))).limit(1);
        if (!ok) throw new ApiError(409, "approval_required", "This purchase needs approval first", { organisationId: proj.org, requiredRole: policy.requiredRole, amountMinor: total, currency: q.currency });
      }
    }
    const [m] = await tx.select().from(merchants).where(eq(merchants.id, q.merchantId)).limit(1);
    const [buyer] = await tx.select({ marketId: users.marketId }).from(users).where(eq(users.id, userId)).limit(1);
    const tax = await productTax(tx, buyer?.marketId ?? null, total);
    const [o] = await tx.insert(merchantOrders).values({ buyerUserId: userId, merchantId: q.merchantId, projectId: r.projectId, taskId: r.taskId, currency: q.currency, subtotalMinor: total, taxMinor: tax.taxMinor, totalMinor: total + tax.taxMinor, taxBreakdown: tax.breakdown }).returning({ id: merchantOrders.id });
    await tx.insert(merchantOrderItems).values({ orderId: o.id, productId: q.productId, name: r.specification.slice(0, 200), quantity: r.quantity, unitPriceMinor: q.unitPriceMinor, amountMinor: total });
    await tx.update(procurementQuotes).set({ status: sql`case when ${procurementQuotes.id} = ${q.id} then 'selected' else 'rejected' end` }).where(eq(procurementQuotes.procurementRequestId, id));
    await tx.update(procurementRequests).set({ status: "ordered", orderId: o.id }).where(eq(procurementRequests.id, id));
    await recordActivity(tx, { projectId: r.projectId, actorUserId: userId, eventType: "procurement.ordered", subjectType: "procurement_request", subjectId: id, payload: { orderId: o.id } });
    if (m) await notify(tx, [m.ownerUserId], "order.created", { orderId: o.id, projectId: r.projectId }, userId);
    return { status: 201, body: { order: { id: o.id, totalMinor: total + tax.taxMinor, currency: q.currency } } };
  });
});
procurementRoutes.post("/:id/accept", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  return runIdempotent(c, { scope: "procurement.accept", userId, body: { id } }, async (tx) => {
    const [r] = await tx.select().from(procurementRequests).where(eq(procurementRequests.id, id)).limit(1).for("update");
    if (!r) throw notFound();
    await requireProjectRole(tx, r.projectId, userId, PROCUREMENT_ROLES);
    const [o] = r.orderId ? await tx.select({ s: merchantOrders.status }).from(merchantOrders).where(eq(merchantOrders.id, r.orderId)).limit(1) : [];
    if (!o || !["delivered", "accepted"].includes(o.s)) throw new ApiError(409, "not_delivered", "The order has not been delivered yet");
    await tx.update(procurementRequests).set({ status: "accepted" }).where(eq(procurementRequests.id, id));
    return { status: 200, body: { procurement: { id, status: "accepted" } } };
  });
});

// ── assets, service history, maintenance reminders (PRD §83-85) ──────────────
export const assetRoutes = new Hono<AuthEnv>();
assetRoutes.use("*", requireAuth);
const assetBody = z.strictObject({
  kind: z.enum(["building", "vehicle", "equipment", "hvac", "solar_system", "appliance", "lock", "machinery", "other"]), name: z.string().trim().min(1).max(200),
  model: z.string().trim().max(120).optional(), serial: z.string().trim().max(120).optional(), installedOn: z.iso.date().optional(), nextServiceOn: z.iso.date().optional(),
  locationNote: z.string().trim().max(500).optional(), organisationId: z.uuid().optional(), siteId: z.uuid().optional(), projectId: z.uuid().optional(),
  installedByProviderProfileId: z.uuid().optional(), attributes: z.record(z.string(), z.unknown()).default({}),
});
assetRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(assetBody, raw);
  return runIdempotent(c, { scope: "assets.create", userId, body: raw }, async (tx) => {
    if (b.projectId) await requireProjectRole(tx, b.projectId, userId, PROJECT_MANAGERS);
    const [a] = await tx.insert(assets).values({ ownerUserId: userId, kind: b.kind, name: b.name, model: b.model ?? null, serial: b.serial ?? null, installedOn: b.installedOn ?? null, nextServiceOn: b.nextServiceOn ?? null, locationNote: b.locationNote ?? null, organisationId: b.organisationId ?? null, siteId: b.siteId ?? null, projectId: b.projectId ?? null, installedByProviderProfileId: b.installedByProviderProfileId ?? null, attributes: b.attributes }).returning({ id: assets.id });
    return { status: 201, body: { asset: { id: a.id, name: b.name } } };
  });
});
assetRoutes.get("/", async (c) => c.json({ assets: await db.select().from(assets).where(eq(assets.ownerUserId, c.get("auth").userId)).orderBy(asc(assets.name)) }));
assetRoutes.get("/due", async (c) => {
  const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 60) || 60));
  const horizon = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  const rows = await db.select().from(assets).where(and(eq(assets.ownerUserId, c.get("auth").userId), lte(assets.nextServiceOn, horizon))).orderBy(asc(assets.nextServiceOn));
  return c.json({ due: rows, horizonDays: days });
});
assetRoutes.get("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const [a] = await db.select().from(assets).where(and(eq(assets.id, id), eq(assets.ownerUserId, userId))).limit(1);
  if (!a) throw notFound();
  const history = await db.select().from(assetServiceHistory).where(eq(assetServiceHistory.assetId, id)).orderBy(desc(assetServiceHistory.performedOn));
  const ws = await db.select().from(warranties).where(eq(warranties.assetId, id)).orderBy(desc(warranties.endsOn));
  return c.json({ asset: a, history, warranties: ws });
});
assetRoutes.post("/:id/service", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ performedOn: z.iso.date(), summary: z.string().trim().min(2).max(2000), providerProfileId: z.uuid().optional(), projectId: z.uuid().optional(), nextServiceOn: z.iso.date().optional() }), raw);
  return runIdempotent(c, { scope: "assets.service", userId, body: { id, raw } }, async (tx) => {
    const [a] = await tx.select({ id: assets.id }).from(assets).where(and(eq(assets.id, id), eq(assets.ownerUserId, userId))).limit(1).for("update");
    if (!a) throw notFound();
    const [h] = await tx.insert(assetServiceHistory).values({ assetId: id, performedOn: b.performedOn, summary: b.summary, providerProfileId: b.providerProfileId ?? null, projectId: b.projectId ?? null, createdByUserId: userId }).returning({ id: assetServiceHistory.id });
    await tx.update(assets).set({ nextServiceOn: b.nextServiceOn ?? null }).where(eq(assets.id, id));
    return { status: 201, body: { service: { id: h.id } } };
  });
});
// PRD §86 "Hire again": reuse the asset, its location and the last provider.
assetRoutes.post("/:id/hire-again", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ note: z.string().trim().max(1000).optional() }), raw);
  return runIdempotent(c, { scope: "assets.hire_again", userId, body: { id, raw } }, async (tx) => {
    const [a] = await tx.select().from(assets).where(and(eq(assets.id, id), eq(assets.ownerUserId, userId))).limit(1);
    if (!a) throw notFound();
    const [last] = await tx.select({ p: assetServiceHistory.providerProfileId }).from(assetServiceHistory).where(and(eq(assetServiceHistory.assetId, id), sql`${assetServiceHistory.providerProfileId} is not null`)).orderBy(desc(assetServiceHistory.performedOn)).limit(1);
    const providerId = last?.p ?? a.installedByProviderProfileId ?? null;
    const [me] = await tx.select({ marketId: users.marketId, lang: users.preferredLanguage }).from(users).where(eq(users.id, userId)).limit(1);
    if (!me?.marketId) throw new ApiError(400, "no_market", "Your account has no market set");
    const text = `Service my ${a.name}${a.model ? ` (${a.model})` : ""}.${b.note ? ` ${b.note}` : ""}`;
    const [r] = await tx.insert(requests).values({ requesterUserId: userId, organisationId: a.organisationId, marketId: me.marketId, rawText: text, originalLanguage: me.lang, status: "open", siteLocation: { assetId: id, locationNote: a.locationNote } }).returning({ id: requests.id });
    if (providerId) await tx.insert(requestCandidates).values({ requestId: r.id, providerProfileId: providerId }).onConflictDoNothing();
    return { status: 201, body: { request: { id: r.id }, invitedProviderId: providerId } };
  });
});

export const projectAfterRoutes = new Hono<AuthEnv>();
projectAfterRoutes.use("*", requireAuth);
projectAfterRoutes.post("/:id/hire-again", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(z.strictObject({ providerProfileId: z.uuid().optional(), note: z.string().trim().max(1000).optional() }), raw);
  return runIdempotent(c, { scope: "projects.hire_again", userId, body: { projectId, raw } }, async (tx) => {
    await requireProjectRole(tx, projectId, userId, PROJECT_MANAGERS);
    const [p] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!p) throw notFound();
    if (!["completed", "aftercare"].includes(p.status)) throw new ApiError(409, "not_finished", "You can hire again once the project is completed");
    const [first] = await tx.select({ cat: tasks.categoryId }).from(tasks).where(eq(tasks.projectId, projectId)).orderBy(asc(tasks.position)).limit(1);
    const [r] = await tx.insert(requests).values({ requesterUserId: userId, organisationId: p.organisationId, marketId: p.marketId, categoryId: first?.cat ?? null, rawText: `Repeat of: ${p.title}.${p.objective ? ` ${p.objective}` : ""}${b.note ? ` ${b.note}` : ""}`.slice(0, 4000), status: "open" }).returning({ id: requests.id });
    if (b.providerProfileId) await tx.insert(requestCandidates).values({ requestId: r.id, providerProfileId: b.providerProfileId }).onConflictDoNothing();
    return { status: 201, body: { request: { id: r.id } } };
  });
});

// ── warranties and claims (PRD §82) ──────────────────────────────────────────
export const warrantyRoutes = new Hono<AuthEnv>();
warrantyRoutes.use("*", requireAuth);
const warrantyBody = z.strictObject({
  kind: z.enum(["workmanship", "manufacturer", "merchant", "platform"]), assetId: z.uuid().optional(), projectId: z.uuid().optional(), grantor: z.string().trim().max(200).optional(),
  providerProfileId: z.uuid().optional(), merchantId: z.uuid().optional(), startsOn: z.iso.date(), endsOn: z.iso.date(), terms: z.string().trim().max(4000).optional(),
});
warrantyRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;
  const raw = await readJson(c);
  const b = parseOrThrow(warrantyBody, raw);
  if (b.endsOn < b.startsOn) throw new ApiError(400, "invalid_period", "endsOn must not be before startsOn");
  return runIdempotent(c, { scope: "warranties.create", userId, body: raw }, async (tx) => {
    if (b.assetId) { const [a] = await tx.select({ id: assets.id }).from(assets).where(and(eq(assets.id, b.assetId), eq(assets.ownerUserId, userId))).limit(1); if (!a) throw notFound(); }
    if (b.projectId) await requireProjectRole(tx, b.projectId, userId, PROJECT_MANAGERS);
    const [w] = await tx.insert(warranties).values({ ownerUserId: userId, kind: b.kind, assetId: b.assetId ?? null, projectId: b.projectId ?? null, grantor: b.grantor ?? null, providerProfileId: b.providerProfileId ?? null, merchantId: b.merchantId ?? null, startsOn: b.startsOn, endsOn: b.endsOn, terms: b.terms ?? null }).returning({ id: warranties.id });
    return { status: 201, body: { warranty: { id: w.id } } };
  });
});
warrantyRoutes.get("/", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.select().from(warranties).where(eq(warranties.ownerUserId, c.get("auth").userId)).orderBy(asc(warranties.endsOn));
  return c.json({ warranties: rows.map((w) => ({ ...w, active: w.startsOn <= today && w.endsOn >= today })) });
});
warrantyRoutes.post("/:id/claims", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const b = parseOrThrow(z.strictObject({ description: z.string().trim().min(5).max(4000) }), await readJson(c));
  return runIdempotent(c, { scope: "warranties.claim", userId, body: { id, b } }, async (tx) => {
    const [w] = await tx.select().from(warranties).where(and(eq(warranties.id, id), eq(warranties.ownerUserId, userId))).limit(1);
    if (!w) throw notFound();
    if (w.endsOn < new Date().toISOString().slice(0, 10)) throw new ApiError(409, "warranty_expired", "This warranty has ended");
    const [cl] = await tx.insert(warrantyClaims).values({ warrantyId: id, claimantUserId: userId, description: b.description }).returning({ id: warrantyClaims.id });
    const grantors: string[] = [];
    if (w.providerProfileId) { const [p] = await tx.select({ u: providerProfiles.userId }).from(providerProfiles).where(eq(providerProfiles.id, w.providerProfileId)).limit(1); if (p) grantors.push(p.u); }
    if (w.merchantId) { const [m] = await tx.select({ u: merchants.ownerUserId }).from(merchants).where(eq(merchants.id, w.merchantId)).limit(1); if (m) grantors.push(m.u); }
    await notify(tx, grantors, "warranty.claim_opened", { warrantyId: id, claimId: cl.id }, userId);
    return { status: 201, body: { claim: { id: cl.id, status: "open" } } };
  });
});
warrantyRoutes.get("/claims/incoming", async (c) => {
  const userId = c.get("auth").userId;
  const [p] = await db.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)).limit(1);
  const [m] = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.ownerUserId, userId)).limit(1);
  const conds = [p ? eq(warranties.providerProfileId, p.id) : undefined, m ? eq(warranties.merchantId, m.id) : undefined].filter((x): x is NonNullable<typeof x> => !!x);
  if (conds.length === 0) return c.json({ claims: [] });
  const rows = await db.select({ cl: warrantyClaims, w: warranties }).from(warrantyClaims).innerJoin(warranties, eq(warranties.id, warrantyClaims.warrantyId)).where(or(...conds)).orderBy(desc(warrantyClaims.createdAt)).limit(100);
  return c.json({ claims: rows.map((r) => ({ ...r.cl, warrantyKind: r.w.kind, grantor: r.w.grantor })) });
});
warrantyRoutes.post("/claims/:id/decide", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const b = parseOrThrow(z.strictObject({ status: z.enum(["accepted", "rejected", "resolved"]) }), await readJson(c));
  return runIdempotent(c, { scope: "warranties.claim_decide", userId, body: { id, b } }, async (tx) => {
    const [r] = await tx.select({ cl: warrantyClaims, w: warranties }).from(warrantyClaims).innerJoin(warranties, eq(warranties.id, warrantyClaims.warrantyId)).where(eq(warrantyClaims.id, id)).limit(1).for("update");
    if (!r) throw notFound();
    const [p] = r.w.providerProfileId ? await tx.select({ u: providerProfiles.userId }).from(providerProfiles).where(eq(providerProfiles.id, r.w.providerProfileId)).limit(1) : [];
    const [m] = r.w.merchantId ? await tx.select({ u: merchants.ownerUserId }).from(merchants).where(eq(merchants.id, r.w.merchantId)).limit(1) : [];
    if (!(p?.u === userId || m?.u === userId || isPlatformAdmin(userId))) throw notFound();
    await tx.update(warrantyClaims).set({ status: b.status }).where(eq(warrantyClaims.id, id));
    await notify(tx, [r.cl.claimantUserId], `warranty.claim_${b.status}`, { claimId: id }, userId);
    return { status: 200, body: { claim: { id, status: b.status } } };
  });
});
