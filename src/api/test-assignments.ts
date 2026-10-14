import "dotenv/config";
import { stableStringify } from "../lib/idempotency";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../db/client";
import { activityEvents, projectMembers, taskInvitations, tasks } from "../db/schema";
import { call, cleanupTestUsers, createProject, expect, registerProvider, registerUser } from "./test-helpers";

// Provider response to an award: list, accept, reject (DECISIONS D35-D36).
// Needs `npm run db:seed`. Run: npm run test:assignments
const stamp = Date.now().toString(36);
const LIKE = "asgtest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;
const code = (r: { json: any }) => r.json?.error?.code;

let A = { token: "", id: "" }; // project owner
let S = { token: "", id: "" }; // stranger
let P1 = { token: "", id: "", providerId: "" };
let P2 = { token: "", id: "", providerId: "" };
let projectId = "";
let t1 = "";
let t2 = "";
let as1 = ""; // P1's assignment on t1 (accepted in the tests)
let as2 = ""; // P2's assignment on t2 (rejected in the tests)

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

const quoteBody = () => ({
  currency: "NGN",
  validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  lines: [{ kind: "labour", description: "Work", quantity: 1, unitPriceMinor: 500000 }],
});

/** invite -> quote -> submit -> accept; returns the new assignment id. */
async function award(task: string, p: { token: string; providerId: string }, tag: string): Promise<string> {
  const inv = await call("POST", `/tasks/${task}/invitations`, { body: { providerProfileId: p.providerId }, token: A.token, key: k(`i-${tag}`) });
  expect(inv.status === 201, `invite ${tag} ${inv.status} ${inv.text}`);
  const q = await call("POST", `/tasks/${task}/quotes`, { body: quoteBody(), token: p.token, key: k(`q-${tag}`) });
  expect(q.status === 201, `quote ${tag} ${q.status} ${q.text}`);
  const sub = await call("POST", `/quotes/${q.json.quote.id}/submit`, { body: {}, token: p.token, key: k(`s-${tag}`) });
  expect(sub.status === 200, `submit ${tag} ${sub.status} ${sub.text}`);
  const acc = await call("POST", `/quotes/${q.json.quote.id}/accept`, { body: {}, token: A.token, key: k(`a-${tag}`) });
  expect(acc.status === 200 && acc.json.assignment.status === "offered", `accept ${tag} ${acc.status} ${acc.text}`);
  return acc.json.assignment.id as string;
}

test("setup: owner, stranger, two providers, two ready tasks, two awards", async () => {
  A = await registerUser(`asgtest-${stamp}-a@test.invalid`);
  S = await registerUser(`asgtest-${stamp}-s@test.invalid`);
  P1 = await registerProvider(`asgtest-${stamp}-p1@test.invalid`, `p1-${stamp}`);
  P2 = await registerProvider(`asgtest-${stamp}-p2@test.invalid`, `p2-${stamp}`);
  const p = await createProject(A.token, `aa-${stamp}`, "Fix the leaking tap");
  projectId = p.projectId; t1 = p.taskId;
  const second = await call("POST", `/projects/${projectId}/tasks`, { body: { title: "Repaint ceiling" }, token: A.token, key: k("t2") });
  expect(second.status === 201, `second task ${second.status} ${second.text}`);
  t2 = second.json.task.id;
  for (const [t, key] of [[t1, "r1"], [t2, "r2"]] as const) {
    const r = await call("POST", `/tasks/${t}/transition`, { body: { to: "ready" }, token: A.token, key: k(key) });
    expect(r.status === 200, `ready ${r.status} ${r.text}`);
  }
  as1 = await award(t1, P1, "p1");
  as2 = await award(t2, P2, "p2");
});

test("list: provider sees only their own assignments; filter validated; auth required", async () => {
  expect((await call("GET", "/assignments")).status === 401, "401 without token");
  const mine = await call("GET", "/assignments", { token: P1.token });
  expect(mine.status === 200 && mine.json.assignments.length === 1, `P1 list ${mine.status} ${mine.text}`);
  const a = mine.json.assignments[0];
  expect(a.id === as1 && a.status === "offered" && a.task.id === t1 && a.task.status === "assigned", `shape ${JSON.stringify(a)}`);
  expect(a.agreedTotalMinor === 500000 && a.agreedCurrency === "NGN" && a.project.id === projectId, `agreed ${JSON.stringify(a)}`);
  const none = await call("GET", "/assignments", { token: S.token });
  expect(none.status === 200 && none.json.assignments.length === 0, "a user with no assignments sees an empty list");
  expect((await call("GET", "/assignments?status=bogus", { token: P1.token })).status === 400, "bad filter is 400");
  const filtered = await call("GET", "/assignments?status=accepted", { token: P1.token });
  expect(filtered.json.assignments.length === 0, "filter excludes non-matching");
});

test("respond: only the assigned provider; key required; body validated; malformed id", async () => {
  const noKey = await call("POST", `/assignments/${as1}/accept`, { body: {}, token: P1.token });
  expect(noKey.status === 400 && code(noKey) === "idempotency_key_required", `no key ${noKey.status}`);
  expect((await call("POST", `/assignments/${as1}/accept`, { body: {}, key: k("x-noauth") })).status === 401, "401");
  for (const [who, tag] of [[A, "owner"], [S, "stranger"], [P2, "other-provider"]] as const) {
    const r = await call("POST", `/assignments/${as1}/accept`, { body: {}, token: who.token, key: k(`x-${tag}`) });
    expect(r.status === 404, `${tag} accept got ${r.status}`);
    const j = await call("POST", `/assignments/${as1}/reject`, { body: {}, token: who.token, key: k(`y-${tag}`) });
    expect(j.status === 404, `${tag} reject got ${j.status}`);
  }
  expect((await call("POST", "/assignments/not-a-uuid/accept", { body: {}, token: P1.token, key: k("x-bad") })).status === 404, "malformed id is 404");
  const extra = await call("POST", `/assignments/${as1}/accept`, { body: { hack: 1 }, token: P1.token, key: k("x-extra") });
  expect(extra.status === 400, `unknown field ${extra.status}`);
  const t = await call("GET", "/assignments", { token: P1.token });
  expect(t.json.assignments[0].status === "offered", "nothing changed after refused attempts");
});

test("accept: assignment and task move together; replay is identical; second response refused", async () => {
  const ok = await call("POST", `/assignments/${as1}/accept`, { body: {}, token: P1.token, key: k("acc-1") });
  expect(ok.status === 200, `accept ${ok.status} ${ok.text}`);
  expect(ok.json.assignment.status === "accepted" && ok.json.assignment.respondedAt && ok.json.task.status === "accepted", `body ${ok.text}`);
  const replay = await call("POST", `/assignments/${as1}/accept`, { body: {}, token: P1.token, key: k("acc-1") });
  expect(replay.status === 200 && replay.replayed && stableStringify(replay.json) === stableStringify(ok.json), "replay returns the stored response");
  const again = await call("POST", `/assignments/${as1}/accept`, { body: {}, token: P1.token, key: k("acc-2") });
  expect(again.status === 409 && code(again) === "assignment_not_offered", `second accept ${again.status} ${again.text}`);
  const rej = await call("POST", `/assignments/${as1}/reject`, { body: {}, token: P1.token, key: k("rej-after") });
  expect(rej.status === 409 && code(rej) === "assignment_not_offered", `reject after accept ${rej.status}`);
  const [row] = await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, t1));
  expect(row?.s === "accepted", `task now ${row?.s}`);
});

test("concurrency: 5 parallel accepts with different keys change state exactly once", async () => {
  // as2 is still offered; race accept vs reject and several accepts. Exactly one response wins.
  const results = await Promise.all([
    ...[1, 2, 3].map((n) => call("POST", `/assignments/${as2}/accept`, { body: {}, token: P2.token, key: k(`race-a${n}`) })),
    ...[1, 2].map((n) => call("POST", `/assignments/${as2}/reject`, { body: {}, token: P2.token, key: k(`race-r${n}`) })),
  ]);
  const wins = results.filter((r) => r.status === 200).length;
  expect(wins === 1, `exactly one winner, got ${wins}: ${results.map((r) => r.status).join(",")}`);
  expect(results.filter((r) => r.status === 409).length === 4, "everyone else gets 409");
});

test("reject: task reopens, invitation declined, membership removed, can re-award", async () => {
  // Make the outcome deterministic regardless of who won the race: build a fresh task for the reject path.
  const third = await call("POST", `/projects/${projectId}/tasks`, { body: { title: "Fix gate" }, token: A.token, key: k("t3") });
  expect(third.status === 201, `third task ${third.status}`);
  const t3 = third.json.task.id as string;
  expect((await call("POST", `/tasks/${t3}/transition`, { body: { to: "ready" }, token: A.token, key: k("r3") })).status === 200, "ready");
  const S3 = await registerProvider(`asgtest-${stamp}-p3@test.invalid`, `p3-${stamp}`);
  const as3 = await award(t3, S3, "p3");
  expect((await call("GET", `/projects/${projectId}`, { token: S3.token })).status === 200, "member while the offer is open");

  const ok = await call("POST", `/assignments/${as3}/reject`, { body: { reason: "Too far away" }, token: S3.token, key: k("rej-3") });
  expect(ok.status === 200, `reject ${ok.status} ${ok.text}`);
  expect(ok.json.assignment.status === "rejected" && ok.json.task.status === "offered", `body ${ok.text}`);
  const replay = await call("POST", `/assignments/${as3}/reject`, { body: { reason: "Too far away" }, token: S3.token, key: k("rej-3") });
  expect(replay.status === 200 && replay.replayed && stableStringify(replay.json) === stableStringify(ok.json), "replay is identical");
  const diff = await call("POST", `/assignments/${as3}/reject`, { body: { reason: "Different" }, token: S3.token, key: k("rej-3") });
  expect(diff.status === 422, `same key, different body ${diff.status}`);

  const inv = await db.select({ s: taskInvitations.status }).from(taskInvitations).where(and(eq(taskInvitations.taskId, t3), eq(taskInvitations.providerProfileId, S3.providerId)));
  expect(inv[0]?.s === "declined", `invitation ${inv[0]?.s}`);
  const mem = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, S3.id)));
  expect(mem.length === 0, "membership removed");
  expect((await call("GET", `/projects/${projectId}`, { token: S3.token })).status === 404, "project is invisible again");

  // Bidding is open again: a different provider can be invited, quote and be awarded.
  const again = await award(t3, P1, "p3-again");
  expect(typeof again === "string" && again !== as3, "a new assignment was created");
});

test("membership survives a reject when the provider still holds another live assignment", async () => {
  // P1 accepted t1 earlier and was just awarded t3. Reject t3: P1 must stay a member because of t1.
  const mine = await call("GET", "/assignments?status=offered", { token: P1.token });
  expect(mine.json.assignments.length === 1, `P1 offered ${mine.text}`);
  const id = mine.json.assignments[0].id as string;
  const r = await call("POST", `/assignments/${id}/reject`, { body: {}, token: P1.token, key: k("rej-keep") });
  expect(r.status === 200, `reject ${r.status} ${r.text}`);
  expect((await call("GET", `/projects/${projectId}`, { token: P1.token })).status === 200, "P1 is still a member");
});

test("activity: one event per step; refused calls add nothing", async () => {
  const ev = await db.select({ t: activityEvents.eventType }).from(activityEvents).where(eq(activityEvents.projectId, projectId));
  const n = (type: string) => ev.filter((e) => e.t === type).length;
  expect(n("assignment.accepted") === 1 + (await wonByAccept()), `assignment.accepted x${n("assignment.accepted")}`);
  expect(n("assignment.rejected") === 2 + (await wonByReject()), `assignment.rejected x${n("assignment.rejected")}`);
  const byOutsiders = await db.select({ id: activityEvents.id }).from(activityEvents).where(eq(activityEvents.actorUserId, S.id));
  expect(byOutsiders.length === 0, "the stranger changed nothing");
});

// as2's outcome depends on the race: 1 if the accept won, 0 if the reject won.
async function wonByAccept(): Promise<number> {
  const r = await call("GET", "/assignments?status=accepted", { token: P2.token });
  return r.json.assignments.some((a: any) => a.id === as2) ? 1 : 0;
}
async function wonByReject(): Promise<number> {
  const r = await call("GET", "/assignments?status=rejected", { token: P2.token });
  return r.json.assignments.some((a: any) => a.id === as2) ? 1 : 0;
}

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
