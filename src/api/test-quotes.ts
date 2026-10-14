import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { activityEvents, assignments, projectMembers, quoteVersions, taskInvitations } from "../db/schema/index.js";
import { computeQuoteAmounts, lineAmountMinor } from "../engine/quote-math.js";
import { canTransition, QUOTE_TRANSITIONS } from "../engine/state-machines.js";
import { call, cleanupTestUsers, createProject, expect, expireQuoteVersion, registerProvider, registerUser } from "./test-helpers.js";

// Invitations, quotes, quote versions, acceptance. Needs `npm run db:seed` and the task_invitations
// migration. Run: npm run test:quotes   
const stamp = Date.now().toString(36);
const LIKE = "quotetest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;

let A = { token: "", id: "" }; // project owner
let B = { token: "", id: "" }; // observer member
let C = { token: "", id: "" }; // stranger
let N = { token: "", id: "" }; // user with no provider profile
let P1 = { token: "", id: "", providerId: "" }; // winner
let P2 = { token: "", id: "", providerId: "" }; // keeps a private draft
let P3 = { token: "", id: "", providerId: "" }; // quote that expires; not invited at first
let P5 = { token: "", id: "", providerId: "" }; // never invited
let projectId = "";
let t1 = ""; // the task everyone quotes on
let t2 = ""; // stays draft
let q1 = "";
let q2 = "";
let q3 = "";
let v1Id = "";

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);
const code = (r: { json: any }) => r.json?.error?.code;
const inThePast = () => new Date(Date.now() - 86_400_000).toISOString();
const inTheFuture = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

const baseQuote = () => ({
  currency: "NGN",
  validUntil: inTheFuture(),
  inspectionRequired: false,
  exclusions: "Ceiling repair is not included",
  lines: [
    { kind: "labour", description: "Fit new tap", quantity: 2, unitPriceMinor: 500000 },
    { kind: "transport", description: "Travel", unitPriceMinor: 150000 },
    { kind: "materials", description: "Optional upgraded washer set", quantity: "1.5", unitPriceMinor: 20000, isOptional: true },
  ],
});

test("pure: money maths and the quote state machine", async () => {
  expect(lineAmountMinor("1.5", 1000) === 1500n, "1.5 x 1000");
  expect(lineAmountMinor("0.333", 100) === 33n, "33.3 rounds down to 33");
  expect(lineAmountMinor("2.5", 3) === 8n, "7.5 rounds half up to 8");
  expect(lineAmountMinor("0.001", 1) === 0n, "0.001 rounds to 0");
  const r = computeQuoteAmounts([
    { quantity: "2", unitPriceMinor: 500000, isOptional: false },
    { quantity: "1", unitPriceMinor: 150000, isOptional: false },
    { quantity: "1.5", unitPriceMinor: 20000, isOptional: true },
  ]);
  expect(r.totalMinor === 1150000 && r.amounts[2] === 30000, `optional lines must stay out of the total: ${JSON.stringify(r)}`);
  let threw = false;
  try { computeQuoteAmounts([{ quantity: "9999999999.999", unitPriceMinor: Number.MAX_SAFE_INTEGER, isOptional: false }]); } catch (e) { threw = e instanceof RangeError; }
  expect(threw, "an unsafe amount must throw RangeError");
  expect(canTransition(QUOTE_TRANSITIONS, "submitted", "accepted"), "submitted -> accepted");
  expect(!canTransition(QUOTE_TRANSITIONS, "accepted", "draft"), "accepted is terminal");
  expect(!canTransition(QUOTE_TRANSITIONS, "submitted", "draft"), "a submitted quote cannot silently go back to draft");
});

test("setup: owner, observer, stranger, providers, project", async () => {
  A = await registerUser(`quotetest-${stamp}-a@test.invalid`);
  B = await registerUser(`quotetest-${stamp}-b@test.invalid`);
  C = await registerUser(`quotetest-${stamp}-c@test.invalid`);
  N = await registerUser(`quotetest-${stamp}-n@test.invalid`);
  P1 = await registerProvider(`quotetest-${stamp}-p1@test.invalid`, `p1-${stamp}`);
  P2 = await registerProvider(`quotetest-${stamp}-p2@test.invalid`, `p2-${stamp}`);
  P3 = await registerProvider(`quotetest-${stamp}-p3@test.invalid`, `p3-${stamp}`);
  P5 = await registerProvider(`quotetest-${stamp}-p5@test.invalid`, `p5-${stamp}`);
  const p = await createProject(A.token, `qa-${stamp}`, "Fix the leaking tap");
  projectId = p.projectId; t1 = p.taskId;
  await db.insert(projectMembers).values({ projectId, userId: B.id, role: "observer" });
  const second = await call("POST", `/projects/${projectId}/tasks`, { body: { title: "Repaint ceiling" }, token: A.token, key: k("t2") });
  expect(second.status === 201, `second task ${second.status} ${second.text}`);
  t2 = second.json.task.id;
  const ready = await call("POST", `/tasks/${t1}/transition`, { body: { to: "ready" }, token: A.token, key: k("t1-ready") });
  expect(ready.status === 200, `ready ${ready.status} ${ready.text}`);
});

test("provider profile: duplicate, read, validation, no profile", async () => {
  const dup = await call("POST", "/providers/me", { body: {}, token: P1.token, key: k("pv-dup") });
  expect(dup.status === 409 && code(dup) === "provider_profile_exists", `dup ${dup.status} ${dup.text}`);
  const me = await call("GET", "/providers/me", { token: P1.token });
  expect(me.status === 200 && me.json.provider.id === P1.providerId, `me ${me.status}`);
  const none = await call("GET", "/providers/me", { token: N.token });
  expect(none.status === 404 && code(none) === "no_provider_profile", `none ${none.status}`);
  const bad = await call("POST", "/providers/me", { body: { kind: "team" }, token: N.token, key: k("pv-bad") });
  expect(bad.status === 400, `team kind ${bad.status}`);
  expect((await call("GET", "/providers/me/invitations", { token: N.token })).status === 404, "inbox without profile");
});

test("invitations: permissions, task state, validation, replay", async () => {
  const inv = (task: string, providerProfileId: string, key: string, token = A.token) =>
    call("POST", `/tasks/${task}/invitations`, { body: { providerProfileId }, token, key: k(key) });
  expect((await call("POST", `/tasks/${t1}/invitations`, { body: { providerProfileId: P1.providerId }, key: k("i-noauth") })).status === 401, "401");
  expect((await inv(t1, P1.providerId, "i-stranger", C.token)).status === 404, "stranger 404");
  expect((await inv(t1, P1.providerId, "i-observer", B.token)).status === 403, "observer 403");
  const draft = await inv(t2, P1.providerId, "i-draft");
  expect(draft.status === 409 && code(draft) === "task_not_offerable", `draft task ${draft.status} ${draft.text}`);
  const unknown = await inv(t1, "00000000-0000-4000-8000-000000000000", "i-unknown");
  expect(unknown.status === 400 && code(unknown) === "provider_invalid", `unknown provider ${unknown.status}`);

  const first = await inv(t1, P1.providerId, "i-p1");
  expect(first.status === 201 && first.json.task.status === "offered", `first ${first.status} ${first.text}`);
  const again = await inv(t1, P1.providerId, "i-p1");
  expect(again.status === 201 && again.replayed, `replay ${again.status}`);
  const dup = await inv(t1, P1.providerId, "i-p1-dup");
  expect(dup.status === 409 && code(dup) === "invitation_exists", `dup ${dup.status}`);
  const second = await inv(t1, P2.providerId, "i-p2");
  expect(second.status === 201 && second.json.task.status === "offered", `second ${second.status}`);
});

test("provider inbox shows the brief only; project and task stay hidden before an award", async () => {
  const box = await call("GET", "/providers/me/invitations", { token: P1.token });
  expect(box.status === 200 && box.json.invitations.length === 1, `inbox ${box.status} ${box.text}`);
  const i = box.json.invitations[0];
  expect(i.taskId === t1 && i.taskTitle && i.status === "invited" && i.quoteId === null && i.projectCurrency === "NGN", `invitation: ${JSON.stringify(i)}`);
  expect((await call("GET", `/projects/${projectId}`, { token: P1.token })).status === 404, "invited provider is not a project member");
  expect((await call("GET", `/tasks/${t1}`, { token: P1.token })).status === 404, "task is not visible to an invited provider");
});

test("create quote: only invited providers, validation, server-computed totals, replay, one open quote", async () => {
  const create = (token: string, body: unknown, key: string, task = t1) => call("POST", `/tasks/${task}/quotes`, { body, token, key: k(key) });
  expect((await create(P5.token, baseQuote(), "c-uninvited")).status === 404, "uninvited provider must get 404");
  const noProfile = await create(N.token, baseQuote(), "c-noprofile");
  expect(noProfile.status === 403 && code(noProfile) === "provider_profile_required", `no profile ${noProfile.status}`);
  expect((await create(A.token, baseQuote(), "c-owner")).status === 403, "project owner has no provider profile");

  const usd = await create(P1.token, { ...baseQuote(), currency: "USD" }, "c-usd");
  expect(usd.status === 400 && code(usd) === "currency_mismatch", `currency ${usd.status} ${usd.text}`);
  expect((await create(P1.token, { ...baseQuote(), lines: [] }, "c-nolines")).status === 400, "empty lines");
  expect((await create(P1.token, { ...baseQuote(), lines: [{ kind: "platform_fee", description: "fee", unitPriceMinor: 1 }] }, "c-fee")).status === 400, "providers cannot add platform_fee");
  expect((await create(P1.token, { ...baseQuote(), totalMinor: 1 }, "c-total")).status === 400, "client-sent total must be rejected");
  expect((await create(P1.token, { ...baseQuote(), lines: [{ kind: "labour", description: "x", quantity: 0, unitPriceMinor: 1 }] }, "c-qty0")).status === 400, "zero quantity");
  expect((await create(P1.token, { ...baseQuote(), lines: [{ kind: "labour", description: "x", unitPriceMinor: 1.5 }] }, "c-float")).status === 400, "fractional minor units");

  const p1Body = baseQuote(); // built once: a replay must send the identical body (validUntil embeds a timestamp)
  const ok = await create(P1.token, p1Body, "c-p1");
  expect(ok.status === 201, `create ${ok.status} ${ok.text}`);
  expect(ok.json.quote.status === "draft" && ok.json.version.version === 1 && ok.json.version.totalMinor === 1150000, `quote: ${JSON.stringify(ok.json.version)}`);
  expect(ok.json.lines.length === 3 && ok.json.lines[0].amountMinor === 1000000 && ok.json.lines[2].amountMinor === 30000 && ok.json.lines[2].isOptional, `lines: ${JSON.stringify(ok.json.lines)}`);
  q1 = ok.json.quote.id; v1Id = ok.json.version.id;
  const replay = await create(P1.token, p1Body, "c-p1");
  expect(replay.status === 201 && replay.replayed && replay.json.quote.id === q1, "replay must return the same quote");
  const second = await create(P1.token, baseQuote(), "c-p1-second");
  expect(second.status === 409 && code(second) === "quote_exists", `second open quote ${second.status}`);
});

test("drafts are private: the manager cannot see them, other providers cannot see them", async () => {
  const list = await call("GET", `/tasks/${t1}/quotes`, { token: A.token });
  expect(list.status === 200 && list.json.quotes.length === 0, `manager list should be empty: ${list.text}`);
  expect((await call("GET", `/quotes/${q1}`, { token: A.token })).status === 404, "manager must not see a draft");
  expect((await call("GET", `/quotes/${q1}`, { token: P1.token })).status === 200, "owner sees own draft");
  expect((await call("GET", `/quotes/${q1}`, { token: P2.token })).status === 404, "other provider");
  expect((await call("GET", `/quotes/${q1}`, { token: C.token })).status === 404, "stranger");
  expect((await call("GET", `/quotes/${q1}`, { token: B.token })).status === 403, "observer member");
  expect((await call("GET", "/quotes/not-a-uuid", { token: A.token })).status === 404, "malformed id");
});

test("edit draft: provider only, totals recomputed", async () => {
  const body = { ...baseQuote(), notes: "Includes a one-year workmanship warranty", lines: [{ kind: "labour", description: "Fit new tap", quantity: "2.5", unitPriceMinor: 400000 }, { kind: "transport", description: "Travel", unitPriceMinor: 150000 }] };
  expect((await call("PUT", `/quotes/${q1}`, { body, token: A.token, key: k("e-owner") })).status === 403, "manager cannot edit a provider's quote");
  const ok = await call("PUT", `/quotes/${q1}`, { body, token: P1.token, key: k("e-p1") });
  expect(ok.status === 200 && ok.json.version.totalMinor === 1150000 && ok.json.lines.length === 2 && ok.json.version.notes, `edit ${ok.status} ${ok.text}`);
});

test("submit: provider only; freezes the version in the database", async () => {
  expect((await call("POST", `/quotes/${q1}/submit`, { body: {}, token: A.token, key: k("s-owner") })).status === 403, "manager cannot submit");
  const ok = await call("POST", `/quotes/${q1}/submit`, { body: {}, token: P1.token, key: k("s-p1") });
  expect(ok.status === 200 && ok.json.quote.status === "submitted" && ok.json.version.submittedAt, `submit ${ok.status} ${ok.text}`);
  const again = await call("POST", `/quotes/${q1}/submit`, { body: {}, token: P1.token, key: k("s-p1-again") });
  expect(again.status === 409 && code(again) === "illegal_transition", `resubmit ${again.status}`);
  const edit = await call("PUT", `/quotes/${q1}`, { body: baseQuote(), token: P1.token, key: k("e-after") });
  expect(edit.status === 409 && code(edit) === "quote_not_editable", `edit after submit ${edit.status}`);
  let threw = false;
  try { await db.update(quoteVersions).set({ notes: "tamper" }).where(eq(quoteVersions.id, v1Id)); } catch { threw = true; }
  expect(threw, "the database must refuse to change a submitted version");
  const box = await call("GET", "/providers/me/invitations", { token: P1.token });
  expect(box.json.invitations[0].status === "quoted" && box.json.invitations[0].quoteStatus === "submitted", `inbox after submit: ${JSON.stringify(box.json.invitations[0])}`);
});

test("manager and provider views of submitted quotes", async () => {
  const list = await call("GET", `/tasks/${t1}/quotes`, { token: A.token });
  expect(list.status === 200 && list.json.quotes.length === 1 && list.json.quotes[0].latest.totalMinor === 1150000 && list.json.quotes[0].providerName, `manager list ${list.text}`);
  const one = await call("GET", `/quotes/${q1}`, { token: A.token });
  expect(one.status === 200 && one.json.version.version === 1 && one.json.lines.length === 2, `manager detail ${one.status}`);
  expect((await call("GET", `/tasks/${t1}/quotes`, { token: P2.token })).json.quotes.length === 0, "an invited provider sees only their own quotes");
  expect((await call("GET", `/tasks/${t1}/quotes`, { token: P5.token })).status === 404, "uninvited provider");
  expect((await call("GET", `/tasks/${t1}/quotes`, { token: C.token })).status === 404, "stranger");
  expect((await call("GET", `/tasks/${t1}/quotes`, { token: B.token })).status === 403, "observer");
});

test("expired-at-submit, private draft kept by P2", async () => {
  const mk = await call("POST", `/tasks/${t1}/quotes`, { body: { ...baseQuote(), validUntil: inThePast() }, token: P2.token, key: k("c-p2") });
  expect(mk.status === 201, `p2 create ${mk.status} ${mk.text}`);
  q2 = mk.json.quote.id;
  const sub = await call("POST", `/quotes/${q2}/submit`, { body: {}, token: P2.token, key: k("s-p2-past") });
  expect(sub.status === 400 && code(sub) === "valid_until_past", `past validity ${sub.status} ${sub.text}`);
  const fix = await call("PUT", `/quotes/${q2}`, { body: baseQuote(), token: P2.token, key: k("e-p2") });
  expect(fix.status === 200, `fix ${fix.status}`);
});

test("revision flow: request, revise to v2, history kept", async () => {
  const rr = (token: string, key: string) => call("POST", `/quotes/${q1}/request-revision`, { body: { reason: "Please drop the transport charge" }, token, key: k(key) });
  expect((await rr(B.token, "r-observer")).status === 403, "observer");
  expect((await rr(P1.token, "r-provider")).status === 403, "provider cannot request a revision of their own quote");
  const ok = await rr(A.token, "r-owner");
  expect(ok.status === 200 && ok.json.quote.status === "revision_requested", `request ${ok.status} ${ok.text}`);
  expect((await rr(A.token, "r-owner-2")).status === 409, "second request");
  expect((await call("PUT", `/quotes/${q1}`, { body: baseQuote(), token: P1.token, key: k("e-during") })).status === 409, "cannot edit while the revision is pending");

  const rev = await call("POST", `/quotes/${q1}/revise`, { body: {}, token: P1.token, key: k("rev-p1") });
  expect(rev.status === 200 && rev.json.quote.status === "draft" && rev.json.version.version === 2 && rev.json.lines.length === 2, `revise ${rev.status} ${rev.text}`);
  expect((await call("POST", `/quotes/${q1}/revise`, { body: {}, token: P1.token, key: k("rev-again") })).status === 409, "revise needs a pending request");

  const cheaper = { ...baseQuote(), lines: [{ kind: "labour", description: "Fit new tap", quantity: "2.5", unitPriceMinor: 400000 }] };
  expect((await call("PUT", `/quotes/${q1}`, { body: cheaper, token: P1.token, key: k("e-v2") })).json?.version?.totalMinor === 1000000, "v2 total");
  const sub = await call("POST", `/quotes/${q1}/submit`, { body: {}, token: P1.token, key: k("s-v2") });
  expect(sub.status === 200 && sub.json.version.version === 2, `submit v2 ${sub.status} ${sub.text}`);

  const v1 = await call("GET", `/quotes/${q1}?version=1`, { token: A.token });
  expect(v1.json.version.totalMinor === 1150000 && v1.json.versions.length === 2, `v1 must be unchanged: ${v1.text}`);
  const latest = await call("GET", `/quotes/${q1}`, { token: A.token });
  expect(latest.json.version.version === 2 && latest.json.version.totalMinor === 1000000, "default is the latest version");
});

test("P3: invited late, quote that expires before the manager answers", async () => {
  const inv = await call("POST", `/tasks/${t1}/invitations`, { body: { providerProfileId: P3.providerId }, token: A.token, key: k("i-p3") });
  expect(inv.status === 201, `invite ${inv.status} ${inv.text}`);
  const mk = await call("POST", `/tasks/${t1}/quotes`, { body: baseQuote(), token: P3.token, key: k("c-p3") });
  expect(mk.status === 201, `create ${mk.status} ${mk.text}`);
  q3 = mk.json.quote.id;
  const sub = await call("POST", `/quotes/${q3}/submit`, { body: {}, token: P3.token, key: k("s-p3") });
  expect(sub.status === 200, `submit ${sub.status} ${sub.text}`);
  await expireQuoteVersion(q3, 1); // deterministic: no sleeping, no dependence on network speed
  const acc = await call("POST", `/quotes/${q3}/accept`, { body: {}, token: A.token, key: k("a-p3") });
  expect(acc.status === 409 && code(acc) === "quote_expired", `expired accept ${acc.status} ${acc.text}`);
});

test("accept: permissions, then two concurrent accepts award exactly once", async () => {
  const acc = (token: string, key: string) => call("POST", `/quotes/${q1}/accept`, { body: {}, token, key: k(key) });
  expect((await acc(B.token, "a-observer")).status === 403, "observer");
  expect((await acc(P1.token, "a-provider")).status === 403, "providers cannot accept their own quote");
  expect((await acc(C.token, "a-stranger")).status === 404, "stranger");

  const [r1, r2] = await Promise.all([acc(A.token, "a-race-1"), acc(A.token, "a-race-2")]);
  const oks = [r1, r2].filter((r) => r.status === 200);
  const losers = [r1, r2].filter((r) => r.status === 409);
  expect(oks.length === 1 && losers.length === 1, `race: ${r1.status} ${r1.text} / ${r2.status} ${r2.text}`);
  const win = oks[0].json;
  expect(win.quote.status === "accepted" && win.quote.acceptedVersion === 2 && win.assignment.status === "offered" && win.task.status === "assigned", `win: ${JSON.stringify(win)}`);

  const replay = await acc(A.token, r1.status === 200 ? "a-race-1" : "a-race-2");
  expect(replay.status === 200 && replay.replayed, `replay ${replay.status}`);
  const rows = await db.select().from(assignments).where(eq(assignments.taskId, t1));
  expect(rows.length === 1 && rows[0].quoteId === q1 && rows[0].providerProfileId === P1.providerId, `assignments: ${JSON.stringify(rows)}`);
});

test("after the award: competing quotes closed, invitations settled, provider scoped to their task", async () => {
  const get = async (id: string, token: string) => (await call("GET", `/quotes/${id}`, { token })).json.quote.status;
  expect((await get(q2, P2.token)) === "withdrawn", "P2's private draft is withdrawn");
  expect((await get(q3, P3.token)) === "rejected", "P3's submitted quote is rejected");
  const inv = await db.select().from(taskInvitations).where(eq(taskInvitations.taskId, t1));
  const st = (p: string) => inv.find((i) => i.providerProfileId === p)?.status;
  expect(st(P1.providerId) === "assigned" && st(P2.providerId) === "expired" && st(P3.providerId) === "expired", `invitations: ${JSON.stringify(inv.map((i) => [i.providerProfileId.slice(0, 4), i.status]))}`);

  const proj = await call("GET", `/projects/${projectId}`, { token: P1.token });
  expect(proj.status === 200 && proj.json.tasks.length === 1 && proj.json.tasks[0].id === t1 && proj.json.tasks[0].status === "assigned", `provider view of project: ${proj.text}`);
  expect((await call("GET", `/tasks/${t1}`, { token: P1.token })).json?.dependsOn?.length === 0, "provider sees their task");
  expect((await call("GET", `/tasks/${t2}`, { token: P1.token })).status === 404, "provider must not see other tasks");
  expect((await call("POST", `/tasks/${t1}/transition`, { body: { to: "cancelled" }, token: P1.token, key: k("p1-cancel") })).status === 403, "provider cannot manage the task");
  const owner = await call("GET", `/projects/${projectId}`, { token: A.token });
  expect(owner.json.tasks.length === 2, "owner still sees every task");
});

test("late actions are refused", async () => {
  expect((await call("POST", `/quotes/${q2}/submit`, { body: {}, token: P2.token, key: k("late-submit") })).status === 409, "submit a withdrawn quote");
  expect((await call("POST", `/quotes/${q1}/withdraw`, { body: {}, token: P1.token, key: k("late-withdraw") })).status === 409, "withdraw an accepted quote");
  expect((await call("POST", `/quotes/${q3}/accept`, { body: {}, token: A.token, key: k("late-accept") })).status === 409, "accept a rejected quote");
  const inv = await call("POST", `/tasks/${t1}/invitations`, { body: { providerProfileId: P5.providerId }, token: A.token, key: k("late-invite") });
  expect(inv.status === 409 && code(inv) === "task_not_offerable", `invite after award ${inv.status}`);
  const create = await call("POST", `/tasks/${t1}/quotes`, { body: baseQuote(), token: P2.token, key: k("late-create") });
  expect(create.status === 409, `new quote after award ${create.status}`);
});

test("activity: every step is recorded once; refused and replayed calls add nothing", async () => {
  const ev = await db.select({ t: activityEvents.eventType }).from(activityEvents).where(eq(activityEvents.projectId, projectId));
  const n = (type: string) => ev.filter((e) => e.t === type).length;
  const want: Array<[string, number]> = [
    ["task.provider_invited", 3], ["quote.created", 3], ["quote.draft_edited", 3], ["quote.submitted", 3],
    ["quote.revision_requested", 1], ["quote.revised", 1], ["quote.accepted", 1], ["assignment.offered", 1],
    ["quote.withdrawn", 1], ["quote.rejected", 1], ["task.transitioned", 3],
  ];
  for (const [type, count] of want) expect(n(type) === count, `${type} x${n(type)} (want ${count})`);
  const stray = ev.length; // C, N and P5 never changed anything
  const byOutsiders = await db.select({ id: activityEvents.id }).from(activityEvents).where(eq(activityEvents.actorUserId, C.id));
  expect(byOutsiders.length === 0 && stray > 0, "refused requests must leave no activity");
});

async function main() {
  let failed = 0;
  await cleanupTestUsers(LIKE);
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`PASS  ${name}`);
      } catch (e) {
        failed++;
        console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
      }
    }
  } finally {
    await cleanupTestUsers(LIKE);
    await queryClient.end();
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
