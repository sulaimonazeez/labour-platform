import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { notifications, projectBaselines, projectBudgets, projects } from "../db/schema/index.js";
import { call, cleanupTestUsers, createProject, expect, registerProvider, registerUser } from "./test-helpers.js";

// Change requests (PRD §58-60, D64-D68), reviews (§91, D69-D70) and notifications (§112, D72).
// Needs `npm run db:seed` and migrations applied. Run: npm run test:changes
const stamp = Date.now().toString(36);
const LIKE = "chgtest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;
const code = (r: { json: any }) => r.json?.error?.code;

let A = { token: "", id: "" };
let S = { token: "", id: "" };
let P1 = { token: "", id: "", providerId: "" };
let P2 = { token: "", id: "", providerId: "" };
let projectId = "";
let t1 = ""; // awarded to P1
let t2 = ""; // unassigned
let t3 = ""; // awarded to P2

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const quoteBody = () => ({
  currency: "NGN",
  validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  lines: [{ kind: "labour", description: "Work", quantity: 1, unitPriceMinor: 500000 }],
});

async function award(task: string, p: { token: string; providerId: string }, tag: string): Promise<void> {
  const inv = await call("POST", `/tasks/${task}/invitations`, { body: { providerProfileId: p.providerId }, token: A.token, key: k(`i-${tag}`) });
  expect(inv.status === 201, `invite ${tag} ${inv.status} ${inv.text}`);
  const q = await call("POST", `/tasks/${task}/quotes`, { body: quoteBody(), token: p.token, key: k(`q-${tag}`) });
  expect(q.status === 201, `quote ${tag} ${q.status} ${q.text}`);
  expect((await call("POST", `/quotes/${q.json.quote.id}/submit`, { body: {}, token: p.token, key: k(`s-${tag}`) })).status === 200, `submit ${tag}`);
  const acc = await call("POST", `/quotes/${q.json.quote.id}/accept`, { body: {}, token: A.token, key: k(`a-${tag}`) });
  expect(acc.status === 200, `accept quote ${tag} ${acc.status} ${acc.text}`);
  expect((await call("POST", `/assignments/${acc.json.assignment.id}/accept`, { body: {}, token: p.token, key: k(`aa-${tag}`) })).status === 200, `accept assignment ${tag}`);
}

const propose = (token: string, key: string, body: Record<string, unknown>) =>
  call("POST", `/projects/${projectId}/changes`, { body: { financialEffect: "no_cost", costDeltaMinor: 0, scheduleDeltaDays: 0, ...body }, token, key: k(key) });
const decide = (id: string, verb: string, token: string, key: string, body: unknown = {}) =>
  call("POST", `/changes/${id}/${verb}`, { body, token, key: k(key) });
const baselineNow = async () => (await db.select({ v: projects.currentBaselineVersion }).from(projects).where(eq(projects.id, projectId)))[0]?.v;

test("setup: owner, stranger, two awarded providers, an unassigned task", async () => {
  A = await registerUser(`chgtest-${stamp}-a@test.invalid`);
  S = await registerUser(`chgtest-${stamp}-s@test.invalid`);
  P1 = await registerProvider(`chgtest-${stamp}-p1@test.invalid`, `c1-${stamp}`);
  P2 = await registerProvider(`chgtest-${stamp}-p2@test.invalid`, `c2-${stamp}`);
  const p = await createProject(A.token, `ch-${stamp}`, "Rewire the shop");
  projectId = p.projectId; t1 = p.taskId;
  for (const [title, set] of [["Paint the walls", (id: string) => (t2 = id)], ["Fit the sign", (id: string) => (t3 = id)]] as const) {
    const r = await call("POST", `/projects/${projectId}/tasks`, { body: { title }, token: A.token, key: k(`mk-${title.length}`) });
    expect(r.status === 201, `task ${title} ${r.status} ${r.text}`);
    set(r.json.task.id);
  }
  for (const t of [t1, t3]) {
    const r = await call("POST", `/tasks/${t}/transition`, { body: { to: "ready" }, token: A.token, key: k(`ready-${t.slice(0, 6)}`) });
    expect(r.status === 200, `ready ${r.status} ${r.text}`);
  }
  await award(t1, P1, "p1");
  await award(t3, P2, "p2");
  await db.update(projectBudgets).set({ approvedMinor: 1_000_000 }).where(eq(projectBudgets.projectId, projectId));
});

test("propose: validation and access", async () => {
  expect(code(await propose(A.token, "v1", { title: "x", financialEffect: "increase", costDeltaMinor: 0, taskIds: [t1] })) === "financial_effect_mismatch", "increase needs a positive amount");
  expect(code(await propose(A.token, "v2", { title: "x", financialEffect: "no_cost", costDeltaMinor: 500, taskIds: [t1] })) === "financial_effect_mismatch", "no_cost must be 0");
  expect(code(await propose(A.token, "v3", { title: "x", financialEffect: "reduction", costDeltaMinor: 500, taskIds: [t1] })) === "financial_effect_mismatch", "reduction needs a negative amount");
  expect((await propose(A.token, "v4", { title: "x", taskIds: [] })).status === 400, "at least one task");
  expect((await propose(A.token, "v5", { title: "x", taskIds: ["00000000-0000-4000-8000-000000000000"] })).status === 400, "task must belong to the project");
  expect((await propose(S.token, "v6", { title: "x", taskIds: [t1] })).status === 404, "stranger 404");
  expect((await propose(P1.token, "v7", { title: "not mine", taskIds: [t2] })).status === 403, "a provider cannot change a task they do not hold");
  expect(code(await propose(A.token, "v8", { title: "both", taskIds: [t1, t3] })) === "one_provider_per_change", "two providers in one change");
});

test("propose + accept: counterparty rule, new baseline, budget moves, replay safe", async () => {
  const before = await baselineNow();
  expect(before === 0, `no baseline before the first change (${before})`);
  const r = await propose(A.token, "m1", { title: "Add two sockets", financialEffect: "increase", costDeltaMinor: 50_000, scheduleDeltaDays: 2, taskIds: [t1] });
  expect(r.status === 201 && r.json.change.status === "proposed", `propose ${r.status} ${r.text}`);
  const id = r.json.change.id as string;
  expect((await baselineNow()) === 1, "first proposal captures baseline v1");
  expect(r.json.change.baseBaselineVersion === 1, "change records the baseline it was proposed against");

  const n = await call("GET", "/notifications", { token: P1.token });
  expect(n.status === 200 && n.json.notifications.some((x: any) => x.kind === "change.proposed" && x.payload.changeId === id), `provider was notified ${n.text}`);
  const own = await call("GET", "/notifications", { token: A.token });
  expect(!own.json.notifications.some((x: any) => x.kind === "change.proposed"), "the proposer is not notified of their own proposal");

  expect((await decide(id, "accept", A.token, "acc-own")).status === 403, "the proposing side cannot accept");
  expect((await decide(id, "accept", S.token, "acc-stranger")).status === 404, "stranger 404");
  expect((await decide(id, "accept", P2.token, "acc-p2")).status === 403, "a different provider (a member, but not the affected one) cannot answer");

  const ok = await decide(id, "accept", P1.token, "acc-p1");
  expect(ok.status === 200 && ok.json.change.status === "applied" && ok.json.baselineVersion === 2, `accept ${ok.status} ${ok.text}`);
  expect((await decide(id, "accept", P1.token, "acc-p1")).replayed, "same key replays");
  expect((await decide(id, "accept", P1.token, "acc-p1-again")).status === 409, "already applied");

  const b = await db.select().from(projectBaselines).where(eq(projectBaselines.projectId, projectId));
  expect(b.length === 2 && b.some((x) => x.version === 2 && x.createdByChangeRequestId === id), "baselines v1 and v2, v2 points at the change");
  const [bud] = await db.select().from(projectBudgets).where(eq(projectBudgets.projectId, projectId));
  expect(bud.approvedMinor === 1_050_000, `approved budget moved by the change (${bud.approvedMinor})`);
  const back = await call("GET", "/notifications", { token: A.token });
  expect(back.json.notifications.some((x: any) => x.kind === "change.accepted"), "proposer told it was accepted");
});

test("a provider proposes on their own task; the manager answers", async () => {
  const r = await propose(P1.token, "p1-cr", { title: "Skip the trunking", financialEffect: "reduction", costDeltaMinor: -20_000, taskIds: [t1] });
  expect(r.status === 201, `provider propose ${r.status} ${r.text}`);
  const id = r.json.change.id as string;
  expect((await decide(id, "accept", P1.token, "p1-self")).status === 403, "a provider cannot accept their own proposal");
  expect((await decide(id, "reject", S.token, "p1-stranger")).status === 404, "stranger 404");
  const ok = await decide(id, "accept", A.token, "p1-mgr");
  expect(ok.status === 200 && ok.json.baselineVersion === 3, `manager accepts ${ok.status} ${ok.text}`);
  const [bud] = await db.select().from(projectBudgets).where(eq(projectBudgets.projectId, projectId));
  expect(bud.approvedMinor === 1_030_000, `reduction applied (${bud.approvedMinor})`);
});

test("reject and withdraw", async () => {
  const r = await propose(A.token, "rj", { title: "Extra coat", taskIds: [t1] });
  const id = r.json.change.id as string;
  expect((await decide(id, "withdraw", P1.token, "rj-w-p1")).status === 403, "only the proposer withdraws");
  expect((await decide(id, "reject", A.token, "rj-own")).status === 403, "proposer cannot reject their own change");
  const rej = await decide(id, "reject", P1.token, "rj-p1", { reason: "Not needed" });
  expect(rej.status === 200 && rej.json.change.status === "rejected", `reject ${rej.status} ${rej.text}`);
  expect((await decide(id, "reject", P1.token, "rj-p1-2")).status === 409, "rejected is final");
  const w = await propose(A.token, "wd", { title: "Withdraw me", taskIds: [t1] });
  const w2 = await decide(w.json.change.id, "withdraw", A.token, "wd-ok");
  expect(w2.status === 200 && w2.json.change.status === "withdrawn", `withdraw ${w2.status} ${w2.text}`);
  expect((await decide(w.json.change.id, "accept", P1.token, "wd-acc")).status === 409, "a withdrawn change cannot be accepted");
  expect((await baselineNow()) === 3, "rejecting and withdrawing never create a baseline");
});

test("stale baseline: a change proposed before another was applied cannot be accepted", async () => {
  const x = await propose(P1.token, "st-x", { title: "Older proposal", taskIds: [t1] });
  const y = await propose(A.token, "st-y", { title: "Newer proposal", taskIds: [t1] });
  expect((await decide(y.json.change.id, "accept", P1.token, "st-acc-y")).status === 200, "Y applied");
  const stale = await decide(x.json.change.id, "accept", A.token, "st-acc-x");
  expect(stale.status === 409 && code(stale) === "baseline_changed", `stale ${stale.status} ${stale.text}`);
});

test("no provider involved: a manager can answer their own change; list visibility", async () => {
  const r = await propose(A.token, "solo", { title: "Rename the room", taskIds: [t2] });
  expect(r.status === 201, `solo propose ${r.status} ${r.text}`);
  const ok = await decide(r.json.change.id, "accept", A.token, "solo-acc");
  expect(ok.status === 200 && ok.json.change.status === "applied", `solo accept ${ok.status} ${ok.text}`);

  const mgr = await call("GET", `/projects/${projectId}/changes`, { token: A.token });
  expect(mgr.status === 200 && mgr.json.changes.length >= 5, `manager sees all ${mgr.text}`);
  const p1 = await call("GET", `/projects/${projectId}/changes`, { token: P1.token });
  expect(p1.status === 200 && p1.json.changes.every((c: any) => c.taskIds.includes(t1)), "P1 sees only changes on their task");
  expect(!p1.json.changes.some((c: any) => c.title === "Rename the room"), "P1 does not see an unrelated change");
  const p2 = await call("GET", `/projects/${projectId}/changes`, { token: P2.token });
  expect(p2.status === 200 && p2.json.changes.every((c: any) => c.taskIds.includes(t3)), "P2 sees nothing about t1");
  expect((await call("GET", `/projects/${projectId}/changes`, { token: S.token })).status === 404, "stranger 404");
});

test("notifications: list, mark one, mark all, others' are invisible", async () => {
  const n = await call("GET", "/notifications", { token: P1.token });
  expect(n.status === 200 && n.json.unread > 0, `unread ${n.text}`);
  const first = n.json.notifications[0].id as string;
  expect((await call("POST", `/notifications/${first}/read`, { body: {}, token: S.token, key: k("nr-s") })).status === 404, "someone else's notification is a 404");
  expect((await call("POST", `/notifications/${first}/read`, { body: {}, token: P1.token, key: k("nr-p1") })).status === 200, "mark one");
  const all = await call("POST", "/notifications/read-all", { body: {}, token: P1.token, key: k("nr-all") });
  expect(all.status === 200, `read-all ${all.text}`);
  const after = await call("GET", "/notifications", { token: P1.token });
  expect(after.json.unread === 0, "everything read");
  const rows = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.userId, A.id), eq(notifications.channel, "in_app")));
  expect(rows.length > 0, "the owner has their own notifications");
});

test("reviews: only after completed work, once per provider, aggregated, reviewer hidden", async () => {
  expect((await call("GET", `/projects/${projectId}/reviews`, { token: P1.token })).status === 403, "providers cannot open the review list");
  const early = await call("POST", `/projects/${projectId}/reviews`, { body: { providerProfileId: P1.providerId, workmanship: 5 }, token: A.token, key: k("rv-early") });
  expect(early.status === 409 && code(early) === "not_completed", `before completion ${early.status} ${early.text}`);

  const run = (verb: string, token: string, key: string) => call("POST", `/tasks/${t1}/${verb}`, { body: {}, token, key: k(key) });
  expect((await run("start", P1.token, "w-start")).status === 200, "start");
  expect((await run("submit", P1.token, "w-submit")).status === 200, "submit");
  expect((await run("approve", A.token, "w-approve")).status === 200, "approve");
  const done = await run("complete", A.token, "w-complete");
  expect(done.status === 200, `complete ${done.status} ${done.text}`);

  const list = await call("GET", `/projects/${projectId}/reviews`, { token: A.token });
  expect(list.status === 200 && list.json.providers.length === 1 && list.json.providers[0].reviewed === false, `reviewable ${list.text}`);
  expect((await call("POST", `/projects/${projectId}/reviews`, { body: { providerProfileId: P1.providerId }, token: A.token, key: k("rv-none") })).status === 400, "at least one rating");
  expect((await call("POST", `/projects/${projectId}/reviews`, { body: { providerProfileId: P1.providerId, workmanship: 6 }, token: A.token, key: k("rv-six") })).status === 400, "ratings are 1 to 5");
  expect((await call("POST", `/projects/${projectId}/reviews`, { body: { providerProfileId: P1.providerId, workmanship: 5 }, token: P1.token, key: k("rv-self") })).status === 403, "a provider cannot review themselves");
  const ok = await call("POST", `/projects/${projectId}/reviews`, { body: { providerProfileId: P1.providerId, workmanship: 5, punctuality: 4, comment: "Tidy and quick" }, token: A.token, key: k("rv-ok") });
  expect(ok.status === 201, `review ${ok.status} ${ok.text}`);
  expect((await call("POST", `/projects/${projectId}/reviews`, { body: { providerProfileId: P1.providerId, workmanship: 1 }, token: A.token, key: k("rv-dup") })).status === 409, "one review per provider per project");
  expect((await call("POST", `/projects/${projectId}/reviews`, { body: { providerProfileId: P2.providerId, workmanship: 5 }, token: A.token, key: k("rv-p2") })).status === 409, "P2 has not completed anything");

  const pub = await call("GET", `/providers/${P1.providerId}/reviews`, { token: S.token });
  expect(pub.status === 200 && pub.json.count === 1 && pub.json.averages.workmanship === 5 && pub.json.averages.punctuality === 4, `aggregate ${pub.text}`);
  expect(pub.json.recent[0].comment === "Tidy and quick" && !JSON.stringify(pub.json).includes(A.id), "comment shown, reviewer never");
  const n = await call("GET", "/notifications", { token: P1.token });
  expect(n.json.notifications.some((x: any) => x.kind === "review.received"), "provider told about the review");
});

async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS  ${name}`); }
      catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
    }
  } finally {
    await cleanupTestUsers(LIKE);
    await queryClient.end();
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
