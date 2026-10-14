import "dotenv/config";
import postgres from "postgres";
import { queryClient } from "../db/client";
import { call, cleanupTestUsers, createProject, expect, registerProvider, registerUser } from "./test-helpers";

// The blueprint layer end to end, with the MOCK AI / translation / speech adapters (no network, no keys).
// Needs: migrations applied, `npm run db:seed` and `npm run db:seed:blueprint`.  Run: npm run test:blueprint
process.env.AI_PROVIDER = "mock";
process.env.TRANSLATION_PROVIDER = "mock";
process.env.SPEECH_PROVIDER = "mock";
process.env.AI_DAILY_LIMIT = "200";

const stamp = Date.now().toString(36);
const LIKE = "bptest-%@test.invalid";
const k = (s: string) => `bp-${stamp}-${s}`;
const code = (r: { json: any }) => r.json?.error?.code;

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

let A = { token: "", id: "" };
let S = { token: "", id: "" };
let P1 = { token: "", id: "", providerId: "" };
let projectId = "";
let taskId = "";
let quoteId = "";
let assignmentId = "";
let orgId = "";

const quoteBody = () => ({ currency: "NGN", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), lines: [{ kind: "labour", description: "Work", quantity: 1, unitPriceMinor: 500000 }] });

test("setup: owner, stranger, provider (French speaker), a ready task awarded and accepted", async () => {
  A = await registerUser(`bptest-${stamp}-a@test.invalid`);
  S = await registerUser(`bptest-${stamp}-s@test.invalid`);
  P1 = await registerProvider(`bptest-${stamp}-p1@test.invalid`, `${stamp}-p1`);
  const p = await createProject(A.token, `${stamp}-proj`, "Fix the leaking tap");
  projectId = p.projectId; taskId = p.taskId;
  expect((await call("POST", `/tasks/${taskId}/transition`, { body: { to: "ready" }, token: A.token, key: k("ready") })).status === 200, "ready");
  const pref = await call("PATCH", "/me/preferences", { body: { preferredLanguage: "fr" }, token: P1.token, key: k("pref") });
  expect(pref.status === 200, `preferences ${pref.status} ${pref.text}`);
  expect((await call("POST", `/tasks/${taskId}/invitations`, { body: { providerProfileId: P1.providerId }, token: A.token, key: k("inv") })).status === 201, "invite");
  const q = await call("POST", `/tasks/${taskId}/quotes`, { body: quoteBody(), token: P1.token, key: k("q") });
  expect(q.status === 201, `quote ${q.status} ${q.text}`);
  quoteId = q.json.quote.id;
  expect((await call("POST", `/quotes/${quoteId}/submit`, { body: {}, token: P1.token, key: k("qs") })).status === 200, "submit");
  const acc = await call("POST", `/quotes/${quoteId}/accept`, { body: {}, token: A.token, key: k("qa") });
  expect(acc.status === 200, `accept ${acc.status} ${acc.text}`);
  assignmentId = acc.json.assignment.id;
  const ok = await call("POST", `/assignments/${assignmentId}/accept`, { body: {}, token: P1.token, key: k("aa") });
  expect(ok.status === 200, `provider accepts ${ok.status} ${ok.text}`);
});

test("taxonomy: categories come from the database; problems are understood; emergencies are flagged", async () => {
  const cats = await call("GET", "/categories?lang=fr", { token: A.token });
  expect(cats.status === 200 && cats.json.categories.length >= 16, `categories ${cats.text.slice(0, 200)}`);
  const solar = cats.json.categories.find((c: any) => c.key === "solar_installation");
  expect(solar && solar.name === "Solaire et énergie de secours", `translated name ${JSON.stringify(solar)}`);
  const door = await call("POST", "/discover/classify", { body: { text: "My door won't lock" }, token: A.token });
  expect(door.json.classification.topKey === "carpentry_doors_locks", `door ${door.text}`);
  const solarQ = await call("POST", "/discover/classify", { body: { text: "I want solar installed" }, token: A.token });
  expect(solarQ.json.classification.path === "ai_assisted", `solar path ${solarQ.text}`);
  const gas = await call("POST", "/discover/classify", { body: { text: "I can smell gas in the kitchen" }, token: A.token });
  expect(gas.json.classification.emergency?.kind === "gas leak", `emergency ${gas.text}`);
});

test("drafts: retrieve a template, review, accept into a real project; accepting twice is refused", async () => {
  const rq = await call("POST", "/requests", { body: { rawText: "I want solar installed", status: "open" }, token: A.token, key: k("rq-solar") });
  expect(rq.status === 201, `request ${rq.status} ${rq.text}`);
  const q = await call("POST", "/ai/questions", { body: { text: "I want solar installed" }, token: A.token });
  expect(q.status === 200 && q.json.questions.length > 0, `questions ${q.text}`);
  const d = await call("POST", `/requests/${rq.json.request.id}/drafts`, { body: {}, token: A.token, key: k("draft-solar") });
  expect(d.status === 201 && d.json.draft.source === "template", `draft source ${d.text.slice(0, 300)}`);
  expect(d.json.draft.labels.includes("from_template"), "labelled as from a template");
  expect(d.json.draft.payload.stages.length === 3, "three stages");
  const acc = await call("POST", `/drafts/${d.json.draft.id}/accept`, { body: { currency: "NGN" }, token: A.token, key: k("draft-acc") });
  expect(acc.status === 201 && acc.json.tasks === 6, `accept ${acc.status} ${acc.text}`);
  const again = await call("POST", `/drafts/${d.json.draft.id}/accept`, { body: { currency: "NGN" }, token: A.token, key: k("draft-acc2") });
  expect(again.status === 409 && code(again) === "not_reviewable", `second accept ${again.status} ${again.text}`);
  const proj = await call("GET", `/projects/${acc.json.project.id}`, { token: A.token });
  expect(proj.status === 200 && proj.json.tasks.length === 6 && proj.json.stages.length === 3, `project shape ${proj.text.slice(0, 200)}`);
  expect((await call("POST", `/drafts/${d.json.draft.id}/reject`, { body: {}, token: S.token, key: k("draft-rej-s") })).status === 409, "a stranger cannot reject someone else's draft");
});

test("AI off: the same flow still works from rules, and says so", async () => {
  process.env.AI_PROVIDER = "none";
  try {
    const rq = await call("POST", "/requests", { body: { rawText: "My door won't lock", status: "open" }, token: A.token, key: k("rq-door") });
    const d = await call("POST", `/requests/${rq.json.request.id}/drafts`, { body: {}, token: A.token, key: k("draft-door") });
    expect(d.status === 201 && d.json.draft.source === "rules" && d.json.draft.labels.includes("rules_generated"), `rules draft ${d.text.slice(0, 300)}`);
    const st = await call("GET", "/ai/status", { token: A.token });
    expect(st.json.ai.available === false, "status reports AI as off");
    const ask = await call("POST", `/projects/${projectId}/assistant/ask`, { body: { question: "What is expected for this task?" }, token: A.token });
    expect(ask.status === 200 && ask.json.source === "record", `assistant answers from the record ${ask.text}`);
  } finally { process.env.AI_PROVIDER = "mock"; }
});

test("chat: task context is translated with provenance, the original is kept, access follows the assignment", async () => {
  const send = await call("POST", `/conversations/task/${taskId}/messages`, { body: { text: "Can you come on Tuesday?" }, token: A.token, key: k("m1") });
  expect(send.status === 201 && send.json.message.translations === 1, `send ${send.status} ${send.text}`);
  const read = await call("GET", `/conversations/task/${taskId}/messages`, { token: P1.token });
  const m = read.json.messages[0];
  expect(m.original.text === "Can you come on Tuesday?" && m.original.language === "en", "original untouched");
  expect(m.display.translated === true && m.display.text.startsWith("[fr]") && m.display.provenance.provider === "mock", `translated display ${JSON.stringify(m.display)}`);
  expect(m.needsConfirmation === false, "task chat is not consequential");
  expect((await call("GET", `/conversations/task/${taskId}/messages`, { token: S.token })).status === 404, "stranger gets 404");
  expect((await call("GET", `/conversations/project/${projectId}/messages`, { token: P1.token })).status === 403, "a provider-only member cannot read project chat");
  const leak = await call("POST", `/conversations/task/${taskId}/messages`, { body: { text: "call me on +234 801 234 5678" }, token: P1.token, key: k("m-leak") });
  expect(leak.status === 201 && leak.json.message.flagged === true, "contact details are flagged for review, not blocked");
  const voice = await call("POST", `/conversations/task/${taskId}/voice`, { body: { storagePath: `projects/${projectId}/voice/x.webm`, mimeType: "audio/webm", durationSec: 5 }, token: P1.token, key: k("voice") });
  expect(voice.status === 201 && voice.json.transcribed === true, `voice ${voice.status} ${voice.text}`);
});

test("chat: consequential contexts ask for Confirm understanding", async () => {
  const s = await call("POST", `/conversations/quote/${quoteId}/messages`, { body: { text: "The price includes transport." }, token: A.token, key: k("mq") });
  expect(s.status === 201, `quote chat ${s.status} ${s.text}`);
  const r1 = await call("GET", `/conversations/quote/${quoteId}/messages`, { token: P1.token });
  const m = r1.json.messages[0];
  expect(r1.json.consequential === true && m.needsConfirmation === true, `needs confirmation ${JSON.stringify(m)}`);
  expect((await call("POST", `/conversations/messages/${m.id}/confirm`, { body: {}, token: P1.token, key: k("conf") })).status === 200, "confirm");
  const r2 = await call("GET", `/conversations/quote/${quoteId}/messages`, { token: P1.token });
  expect(r2.json.messages[0].needsConfirmation === false && r2.json.messages[0].confirmed === true, "now confirmed");
  const un = await call("GET", "/conversations/unread", { token: P1.token });
  expect(un.status === 200 && un.json.conversations.length >= 1, "unread summary");
});

test("scheduling: booking, conflict, reschedule, cancellation policy, check-in", async () => {
  const start = new Date(Date.now() + 3 * 86_400_000); start.setUTCHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3600_000);
  const b = await call("POST", `/tasks/${taskId}/bookings`, { body: { startsAt: start.toISOString(), endsAt: end.toISOString(), travelBufferMin: 30 }, token: A.token, key: k("bk") });
  expect(b.status === 201 && Array.isArray(b.json.warnings), `book ${b.status} ${b.text}`);
  const id = b.json.booking.id;
  expect((await call("POST", `/bookings/${id}/confirm`, { body: {}, token: A.token, key: k("bk-own") })).status === 409, "the proposer cannot confirm their own proposal");
  expect((await call("POST", `/bookings/${id}/confirm`, { body: {}, token: P1.token, key: k("bk-ok") })).status === 200, "provider confirms");
  const clash = await call("POST", `/tasks/${taskId}/bookings`, { body: { startsAt: new Date(start.getTime() + 30 * 60_000).toISOString(), endsAt: end.toISOString() }, token: A.token, key: k("bk-clash") });
  expect(clash.status === 409 && code(clash) === "booking_conflict", `clash ${clash.status} ${clash.text}`);
  const mv = await call("POST", `/bookings/${id}/reschedule`, { body: { startsAt: new Date(start.getTime() + 86_400_000).toISOString(), endsAt: new Date(end.getTime() + 86_400_000).toISOString() }, token: A.token, key: k("bk-mv") });
  expect(mv.status === 201 && mv.json.booking.replaces === id, `reschedule ${mv.status} ${mv.text}`);
  const cancel = await call("POST", `/bookings/${mv.json.booking.id}/cancel`, { body: { reason: "Plans changed" }, token: A.token, key: k("bk-cancel") });
  expect(cancel.status === 200 && cancel.json.policy.feePercent === 0, `cancel while only proposed is free ${cancel.text}`);
  expect((await call("POST", `/bookings/${id}/no-show`, { body: { party: "provider" }, token: A.token, key: k("bk-ns") })).status === 409, "no-show before the start time is refused");
  const ci = await call("POST", `/tasks/${taskId}/check-in`, { body: { kind: "en_route", etaMinutes: 20, lat: 6.52441, lng: 3.37921 }, token: P1.token, key: k("ci") });
  expect(ci.status === 201, `check-in ${ci.status} ${ci.text}`);
  expect((await call("POST", `/tasks/${taskId}/check-in`, { body: { kind: "arrived" }, token: A.token, key: k("ci-a") })).status === 403, "only the assigned provider checks in");
  const list = await call("GET", `/tasks/${taskId}/check-ins`, { token: A.token });
  expect(list.status === 200 && Number(list.json.checkIns[0].approxLat) === 6.524, `coordinates are rounded ${list.text}`);
  const av = await call("PUT", "/providers/me/availability", { body: { windows: [{ weekday: 1, startMinute: 480, endMinute: 1020 }] }, token: P1.token, key: k("av") });
  expect(av.status === 200, `availability ${av.status} ${av.text}`);
});

test("updates, issues and safety: providers only touch their own task; transitions are enforced", async () => {
  const u = await call("POST", `/projects/${projectId}/updates`, { body: { kind: "blocker", body: "Need a new washer", taskId }, token: P1.token, key: k("up") });
  expect(u.status === 201, `update ${u.status} ${u.text}`);
  expect((await call("POST", `/projects/${projectId}/updates`, { body: { body: "general note" }, token: P1.token, key: k("up2") })).status === 403, "a provider cannot post project-wide");
  const list = await call("GET", `/projects/${projectId}/updates`, { token: A.token });
  expect(list.json.updates.length === 1, "owner sees the blocker");
  const i = await call("POST", `/projects/${projectId}/issues`, { body: { title: "Washer unavailable", category: "material_unavailable", severity: "high", affectedTaskIds: [taskId] }, token: A.token, key: k("iss") });
  expect(i.status === 201, `issue ${i.status} ${i.text}`);
  const noRes = await call("POST", `/issues/${i.json.issue.id}/status`, { body: { status: "resolved" }, token: A.token, key: k("iss-r0") });
  expect(noRes.status === 400 && code(noRes) === "resolution_required", `resolution needed ${noRes.text}`);
  expect((await call("POST", `/issues/${i.json.issue.id}/status`, { body: { status: "resolved", resolution: "Ordered a washer" }, token: A.token, key: k("iss-r1") })).status === 200, "resolve");
  expect((await call("POST", `/issues/${i.json.issue.id}/status`, { body: { status: "acknowledged" }, token: A.token, key: k("iss-r2") })).status === 409, "invalid transition");
  const inc = await call("POST", "/safety-incidents", { body: { projectId, taskId, category: "fire", severity: "critical", description: "Spark from the socket" }, token: P1.token, key: k("inc") });
  expect(inc.status === 201 && typeof inc.json.emergencyNote === "string", `incident ${inc.status} ${inc.text}`);
  const brief = await call("GET", `/projects/${projectId}/brief`, { token: A.token });
  expect(brief.status === 200 && typeof brief.json.brief.derivedHealth === "string", `brief ${brief.text.slice(0, 200)}`);
  const hc = await call("GET", `/projects/${projectId}/handover`, { token: A.token });
  expect(hc.status === 200 && hc.json.canClose === false, "cannot hand over while work is open");
});

test("disputes: scoped to one task, facts and claims kept apart, a person decides", async () => {
  const d = await call("POST", `/projects/${projectId}/disputes`, { body: { scopeType: "task", scopeId: taskId, reason: "not_completed", description: "Tap still leaks" }, token: A.token, key: k("dis") });
  expect(d.status === 201 && d.json.dispute.status === "awaiting_response" && d.json.dispute.frozenMilestone === false, `open ${d.status} ${d.text}`);
  const id = d.json.dispute.id;
  expect((await call("GET", `/disputes/${id}`, { token: S.token })).status === 404, "stranger cannot see it");
  const resp = await call("POST", `/disputes/${id}/entries`, { body: { kind: "response", body: "It was a different pipe." }, token: P1.token, key: k("dis-r") });
  expect(resp.status === 201, `response ${resp.status} ${resp.text}`);
  const got = await call("GET", `/disputes/${id}`, { token: A.token });
  expect(got.json.dispute.status === "in_review", "moves to review once both sides spoke");
  const sum = await call("GET", `/disputes/${id}/summary`, { token: A.token });
  expect(sum.status === 200 && sum.json.summary.claims.length === 2 && /does not decide/i.test(sum.json.summary.note), `summary ${sum.text.slice(0, 300)}`);
  expect((await call("POST", `/disputes/${id}/resolve`, { body: { resolutionKind: "other", resolution: "agreed" }, token: A.token, key: k("dis-x") })).status === 404, "only platform staff resolve (the staff door answers 404, as everywhere else)");
  const prop = await call("POST", `/disputes/${id}/entries`, { body: { kind: "proposal", body: "Provider returns Friday at no cost" }, token: P1.token, key: k("dis-p") });
  const acc = await call("POST", `/disputes/${id}/accept-proposal`, { body: { entryId: prop.json.entry.id }, token: A.token, key: k("dis-acc") });
  expect(acc.status === 200 && acc.json.dispute.status === "resolved", `accept ${acc.status} ${acc.text}`);
  const t = await call("GET", `/projects/${projectId}`, { token: A.token });
  expect(t.json.tasks.every((x: any) => x.status !== "disputed"), "the task itself was never frozen");
});

test("organisations: approval policy gates a purchase; you cannot approve your own request", async () => {
  const o = await call("POST", "/orgs", { body: { name: `BP Org ${stamp}`, type: "business" }, token: A.token, key: k("org") });
  expect(o.status === 201, `org ${o.status} ${o.text}`);
  orgId = o.json.organisation.id;
  const mem = await call("POST", `/orgs/${orgId}/members`, { body: { email: `bptest-${stamp}-s@test.invalid`, role: "finance_approver" }, token: A.token, key: k("org-m") });
  expect(mem.status === 201, `member ${mem.status} ${mem.text}`);
  expect((await call("POST", `/orgs/${orgId}/approval-policies`, { body: { subjectType: "procurement", thresholdMinor: 100000, currency: "NGN" }, token: A.token, key: k("org-pol") })).status === 201, "policy");
  const small = await call("POST", `/orgs/${orgId}/approval-requests`, { body: { subjectType: "procurement", subjectId: projectId, amountMinor: 50000, currency: "NGN" }, token: A.token, key: k("ar-s") });
  expect(small.json.approval.status === "not_required", "below threshold needs nothing");
  const big = await call("POST", `/orgs/${orgId}/approval-requests`, { body: { subjectType: "procurement", subjectId: projectId, amountMinor: 150000, currency: "NGN" }, token: A.token, key: k("ar-b") });
  expect(big.json.approval.status === "pending", `pending ${big.text}`);
  expect((await call("POST", `/approvals/${big.json.approval.id}/decide`, { body: { decision: "approved" }, token: A.token, key: k("ar-self") })).status === 403, "self-approval refused");
  expect((await call("POST", `/approvals/${big.json.approval.id}/decide`, { body: { decision: "approved" }, token: S.token, key: k("ar-ok") })).status === 200, "finance approver approves");
  const st = await call("GET", `/approvals/status?subjectType=procurement&subjectId=${projectId}`, { token: A.token });
  expect(st.json.cleared === true, `cleared ${st.text}`);
  const ins = await call("GET", "/insights/market", { token: A.token });
  expect(ins.status === 200 && ins.json.minimumGroupSize >= 2, `insights ${ins.status} ${ins.text.slice(0, 200)}`);
  expect((await call("GET", "/insights/market", { token: P1.token })).status === 403, "insights are for organisations");
});

test("commerce: stock, tax, independent order state, procurement", async () => {
  const m = await call("POST", "/merchants", { body: { displayName: `BP Store ${stamp}` }, token: P1.token, key: k("mer") });
  expect(m.status === 201, `merchant ${m.status} ${m.text}`);
  const p = await call("POST", "/merchants/me/products", { body: { sku: "WASH-1", name: "Tap washer", priceMinor: 10000, currency: "NGN", stock: 5, warrantyMonths: 6 }, token: P1.token, key: k("prod") });
  expect(p.status === 201, `product ${p.status} ${p.text}`);
  const o = await call("POST", "/orders", { body: { merchantId: m.json.merchant.id, items: [{ productId: p.json.product.id, quantity: 2 }], projectId, taskId }, token: A.token, key: k("ord") });
  expect(o.status === 201 && o.json.order.subtotalMinor === 20000 && o.json.order.paymentState === "created", `order ${o.status} ${o.text}`);
  const over = await call("POST", "/orders", { body: { merchantId: m.json.merchant.id, items: [{ productId: p.json.product.id, quantity: 10 }] }, token: A.token, key: k("ord-over") });
  expect(over.status === 409 && code(over) === "out_of_stock", `stock ${over.text}`);
  expect((await call("POST", `/orders/${o.json.order.id}/confirm`, { body: {}, token: A.token, key: k("ord-c-buyer") })).status === 403, "only the merchant confirms");
  expect((await call("POST", `/orders/${o.json.order.id}/confirm`, { body: {}, token: P1.token, key: k("ord-c") })).status === 200, "merchant confirms");
  const cancel = await call("POST", `/orders/${o.json.order.id}/cancel`, { body: {}, token: A.token, key: k("ord-x") });
  expect(cancel.status === 200, "buyer cancels before shipping");
  const mine = await call("GET", "/merchants/me/products", { token: P1.token });
  expect(mine.json.products[0].stock === 5, `stock restored ${mine.text}`);
  const pr = await call("POST", `/projects/${projectId}/procurement`, { body: { specification: "20 x 15mm washers", quantity: 20, taskId }, token: A.token, key: k("proc") });
  expect(pr.status === 201, `procurement ${pr.status} ${pr.text}`);
  const q = await call("POST", `/procurement/${pr.json.procurement.id}/quotes`, { body: { productId: p.json.product.id, unitPriceMinor: 9000, currency: "NGN", leadDays: 2 }, token: P1.token, key: k("proc-q") });
  expect(q.status === 201, `proc quote ${q.status} ${q.text}`);
  const list = await call("GET", `/projects/${projectId}/procurement`, { token: A.token });
  const sel = await call("POST", `/procurement/${pr.json.procurement.id}/select`, { body: { quoteId: list.json.procurement[0].quotes[0].id }, token: A.token, key: k("proc-s") });
  expect(sel.status === 201 && sel.json.order.totalMinor >= 180000, `selected ${sel.status} ${sel.text}`);
});

test("assets, warranties and aftercare; recurring service generates a project once per due date", async () => {
  const a = await call("POST", "/assets", { body: { kind: "appliance", name: "Water heater", model: "WH-200", nextServiceOn: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) }, token: A.token, key: k("asset") });
  expect(a.status === 201, `asset ${a.status} ${a.text}`);
  const due = await call("GET", "/assets/due?days=30", { token: A.token });
  expect(due.json.due.length === 1, "maintenance reminder");
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  const w = await call("POST", "/warranties", { body: { kind: "workmanship", assetId: a.json.asset.id, startsOn: today, endsOn: end, providerProfileId: P1.providerId }, token: A.token, key: k("war") });
  expect(w.status === 201, `warranty ${w.status} ${w.text}`);
  const c = await call("POST", `/warranties/${w.json.warranty.id}/claims`, { body: { description: "Leaks after a month" }, token: A.token, key: k("claim") });
  expect(c.status === 201, `claim ${c.status} ${c.text}`);
  const inc = await call("GET", "/warranties/claims/incoming", { token: P1.token });
  expect(inc.json.claims.length === 1, "the grantor sees the claim");
  const h = await call("POST", `/assets/${a.json.asset.id}/hire-again`, { body: {}, token: A.token, key: k("again") });
  expect(h.status === 201, `hire again ${h.status} ${h.text}`);
  const r = await call("POST", "/recurring", { body: { title: "Monthly AC service", frequency: "monthly", startsOn: today, currency: "NGN", taskTemplate: [{ title: "Service the unit" }] }, token: A.token, key: k("rec") });
  expect(r.status === 201, `recurring ${r.status} ${r.text}`);
  const run = await call("POST", `/recurring/${r.json.recurring.id}/run-now`, { body: {}, token: A.token, key: k("rec-run") });
  expect(run.status === 200 && run.json.generated?.projectId, `generated ${run.text}`);
  const run2 = await call("POST", `/recurring/${r.json.recurring.id}/run-now`, { body: {}, token: A.token, key: k("rec-run2") });
  expect(run2.json.generated?.dueOn !== run.json.generated.dueOn, "the next run is the next due date, not a duplicate");
});

test("trust, privacy, account: explainable trust; export contains my data; preferences validate", async () => {
  const t = await call("GET", `/providers/${P1.providerId}/trust`, { token: A.token });
  expect(t.status === 200 && "workHistory" in t.json.trust && "howToRead" in t.json.trust, `trust ${t.text.slice(0, 200)}`);
  const rank = await call("GET", "/discover/providers?limit=5", { token: A.token });
  expect(rank.status === 200 && Array.isArray(rank.json.results), `ranking ${rank.status} ${rank.text.slice(0, 200)}`);
  const first = rank.json.results.find((r: any) => r.providerId === P1.providerId);
  expect(first && first.reasons.length > 0 && first.breakdown.newcomer > 0, `explainable and fair to newcomers ${JSON.stringify(first)}`);
  const bad = await call("PATCH", "/me/preferences", { body: { preferredLanguage: "xx" }, token: A.token, key: k("pref-bad") });
  expect(bad.status === 400 && code(bad) === "unknown_language", `bad language ${bad.text}`);
  const ex = await call("POST", "/me/privacy-requests", { body: { kind: "export" }, token: A.token, key: k("exp") });
  expect(ex.status === 201 && ex.json.export.account.id === A.id && Array.isArray(ex.json.export.messagesSent), `export ${ex.status} ${ex.text.slice(0, 200)}`);
  const del = await call("POST", "/me/privacy-requests", { body: { kind: "delete" }, token: A.token, key: k("del") });
  expect(del.status === 201 && del.json.request.status === "received", "deletion is recorded for review");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
  }
  // Cleanup: translations are append-only, and organisations have no cascade from users. Handle both, then the shared cleanup.
  const url = process.env.DIRECT_URL;
  let orgIds: string[] = [];
  if (url) {
    const admin = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await admin.begin(async (t) => {
        const ids = (await t`select id from users where email like ${LIKE}`).map((r) => r.id as string);
        if (ids.length === 0) return;
        orgIds = (await t`select distinct organisation_id as id from organisation_members where user_id in ${t(ids)}`).map((r) => r.id as string);
        await t`alter table message_translations disable trigger trg_message_translations_append_only`;
        await t`delete from message_translations where message_id in (select id from messages where sender_user_id in ${t(ids)} or project_id in (select id from projects where owner_user_id in ${t(ids)}))`;
        await t`alter table message_translations enable trigger trg_message_translations_append_only`;
        await t`delete from ai_interactions where user_id in ${t(ids)}`;
        await t`delete from procurement_requests where project_id in (select id from projects where owner_user_id in ${t(ids)})`;
        await t`delete from merchant_orders where buyer_user_id in ${t(ids)}`;
      });
    } catch (e) { console.log(`WARN  pre-cleanup failed: ${(e as Error).message}`); }
    finally { await admin.end({ timeout: 2 }); }
  }
  await cleanupTestUsers(LIKE);
  if (url && orgIds.length > 0) {
    const admin = postgres(url, { max: 1, onnotice: () => {} });
    try { await admin`delete from organisations where id in ${admin(orgIds)}`; } catch (e) { console.log(`WARN  org cleanup: ${(e as Error).message}`); } finally { await admin.end({ timeout: 2 }); }
  }
  await queryClient.end();
  console.log(failed === 0 ? `\nAll ${tests.length} blueprint tests passed.` : `\n${failed} of ${tests.length} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();
