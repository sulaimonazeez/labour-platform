import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client";
import { activityEvents, tasks } from "../db/schema";
import { call, cleanupTestUsers, createProject, expect, registerProvider, registerUser } from "./test-helpers";
import { forceFunded } from "./test-fund";

// Task work lifecycle: start, submit, request changes, approve, complete (DECISIONS D41-D44).
// Needs `npm run db:seed`. Run: npm run test:task-work
const stamp = Date.now().toString(36);
const LIKE = "twtest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;
const code = (r: { json: any }) => r.json?.error?.code;

let A = { token: "", id: "" };
let S = { token: "", id: "" };
let P1 = { token: "", id: "", providerId: "" };
let P2 = { token: "", id: "", providerId: "" };
let projectId = "";
let t1 = ""; // P1, the main flow
let t2 = ""; // P2
let t3 = ""; // P1, finish_to_start after t1
let as1 = "";

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);
const path = (n: string) => `projects/${projectId}/${n}-${stamp}.jpg`;

const quoteBody = () => ({
  currency: "NGN",
  validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  lines: [{ kind: "labour", description: "Work", quantity: 1, unitPriceMinor: 500000 }],
});

async function award(task: string, p: { token: string; providerId: string }, tag: string): Promise<string> {
  const inv = await call("POST", `/tasks/${task}/invitations`, { body: { providerProfileId: p.providerId }, token: A.token, key: k(`i-${tag}`) });
  expect(inv.status === 201, `invite ${tag} ${inv.status} ${inv.text}`);
  const q = await call("POST", `/tasks/${task}/quotes`, { body: quoteBody(), token: p.token, key: k(`q-${tag}`) });
  expect(q.status === 201, `quote ${tag} ${q.status} ${q.text}`);
  expect((await call("POST", `/quotes/${q.json.quote.id}/submit`, { body: {}, token: p.token, key: k(`s-${tag}`) })).status === 200, `submit ${tag}`);
  const acc = await call("POST", `/quotes/${q.json.quote.id}/accept`, { body: {}, token: A.token, key: k(`a-${tag}`) });
  expect(acc.status === 200, `accept quote ${tag} ${acc.status} ${acc.text}`);
  const id = acc.json.assignment.id as string;
  expect((await call("POST", `/assignments/${id}/accept`, { body: {}, token: p.token, key: k(`aa-${tag}`) })).status === 200, `accept assignment ${tag}`);
  return id;
}

const act = (task: string, verb: string, key: string, token: string, body: unknown = {}) =>
  call("POST", `/tasks/${task}/${verb}`, { body, token, key: k(key) });
const taskStatus = async (id: string) => (await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, id)))[0]?.s;

test("setup: three tasks, a dependency, two awarded providers", async () => {
  A = await registerUser(`twtest-${stamp}-a@test.invalid`);
  S = await registerUser(`twtest-${stamp}-s@test.invalid`);
  P1 = await registerProvider(`twtest-${stamp}-p1@test.invalid`, `p1-${stamp}`);
  P2 = await registerProvider(`twtest-${stamp}-p2@test.invalid`, `p2-${stamp}`);
  const p = await createProject(A.token, `wa-${stamp}`, "Fix the leaking tap");
  projectId = p.projectId; t1 = p.taskId;
  for (const [title, set] of [["Repaint ceiling", (id: string) => (t2 = id)], ["Seal the roof", (id: string) => (t3 = id)]] as const) {
    const r = await call("POST", `/projects/${projectId}/tasks`, { body: { title }, token: A.token, key: k(`mk-${title.length}`) });
    expect(r.status === 201, `task ${title} ${r.status}`);
    set(r.json.task.id);
  }
  const dep = await call("POST", `/tasks/${t3}/dependencies`, { body: { dependsOnTaskId: t1 }, token: A.token, key: k("dep") });
  expect(dep.status === 201, `dependency ${dep.status} ${dep.text}`);
  for (const [t, key] of [[t1, "r1"], [t2, "r2"], [t3, "r3"]] as const) {
    expect((await call("POST", `/tasks/${t}/transition`, { body: { to: "ready" }, token: A.token, key: k(key) })).status === 200, `ready ${key}`);
  }
  as1 = await award(t1, P1, "p1");
  await award(t2, P2, "p2");
  await award(t3, P1, "p3");
});

test("start: only the assigned provider; dependencies gate it; replay; once only", async () => {
  expect((await call("POST", `/tasks/${t1}/start`, { body: {} })).status === 401, "401");
  const noKey = await call("POST", `/tasks/${t1}/start`, { body: {}, token: P1.token });
  expect(noKey.status === 400 && code(noKey) === "idempotency_key_required", `no key ${noKey.status}`);
  expect((await act(t1, "start", "st-owner", A.token)).status === 403, "owner cannot start");
  expect((await act(t1, "start", "st-stranger", S.token)).status === 404, "stranger 404");
  expect((await act(t1, "start", "st-p2", P2.token)).status === 404, "another provider 404");
  expect((await act("not-a-uuid", "start", "st-bad", P1.token)).status === 404, "malformed id 404");

  const blocked = await act(t3, "start", "st-t3-early", P1.token);
  expect(blocked.status === 409 && code(blocked) === "dependencies_not_met" && blocked.json.error.details.unmetCount === 1, `t3 early ${blocked.status} ${blocked.text}`);
  expect(!blocked.text.includes(t1), "the blocking task id must not leak to a provider");

  const ok = await act(t1, "start", "st-ok", P1.token);
  expect(ok.status === 200 && ok.json.task.status === "in_progress" && ok.json.assignment.status === "active", `start ${ok.status} ${ok.text}`);
  const replay = await act(t1, "start", "st-ok", P1.token);
  expect(replay.status === 200 && replay.replayed, "replay");
  const again = await act(t1, "start", "st-again", P1.token);
  expect(again.status === 409, `second start ${again.status} ${again.text}`);
  const list = await call("GET", "/assignments?status=active", { token: P1.token });
  expect(list.json.assignments.some((a: any) => a.id === as1), "assignment is active");
});

test("submit: evidence requirement enforced, then closed to new evidence", async () => {
  expect((await act(t1, "submit", "sb-owner", A.token)).status === 403, "owner cannot submit");
  expect((await act(t1, "submit", "sb-p2", P2.token)).status === 404, "other provider 404");
  await db.update(tasks).set({ evidenceRequirements: { minCount: 1, kinds: ["photo_after"] } }).where(eq(tasks.id, t1));
  const short = await act(t1, "submit", "sb-short", P1.token);
  expect(short.status === 409 && code(short) === "evidence_requirements_not_met" && short.json.error.details.have === 0, `short ${short.status} ${short.text}`);
  const ev = await call("POST", `/tasks/${t1}/evidence`, { body: { kind: "photo_after", storagePath: path("done") }, token: P1.token, key: k("ev-done") });
  expect(ev.status === 201, `evidence ${ev.status} ${ev.text}`);
  const ok = await act(t1, "submit", "sb-ok", P1.token, { note: "Finished" });
  expect(ok.status === 200 && ok.json.task.status === "submitted", `submit ${ok.status} ${ok.text}`);
  expect((await act(t1, "submit", "sb-ok", P1.token, { note: "Finished" })).replayed, "replay");
  expect((await act(t1, "submit", "sb-again", P1.token)).status === 409, "second submit");
  const late = await call("POST", `/tasks/${t1}/evidence`, { body: { kind: "photo_after", storagePath: path("late") }, token: P1.token, key: k("ev-late") });
  expect(late.status === 409 && code(late) === "task_not_open_for_evidence", `late evidence ${late.status}`);
});

test("changes requested: reason needed, manager only, provider resubmits", async () => {
  expect((await act(t1, "request-changes", "rc-p1", P1.token, { reason: "x" })).status === 403, "provider cannot request changes");
  expect((await act(t1, "request-changes", "rc-none", A.token, {})).status === 400, "reason required");
  const rc = await act(t1, "request-changes", "rc-ok", A.token, { reason: "Tidy the area" });
  expect(rc.status === 200 && rc.json.task.status === "in_progress", `rc ${rc.status} ${rc.text}`);
  expect((await act(t1, "request-changes", "rc-twice", A.token, { reason: "again" })).status === 409, "not submitted any more");
  expect((await act(t1, "submit", "sb-2", P1.token)).status === 200, "resubmit");
});

test("approve and complete: manager only, in order, milestones must be settled", async () => {
  expect((await act(t1, "approve", "ap-p1", P1.token)).status === 403, "provider cannot approve");
  expect((await act(t1, "approve", "ap-stranger", S.token)).status === 404, "stranger 404");
  expect((await act(t1, "complete", "co-early", A.token)).status === 409, "cannot complete before approval");
  const ap = await act(t1, "approve", "ap-ok", A.token);
  expect(ap.status === 200 && ap.json.task.status === "approved", `approve ${ap.status} ${ap.text}`);
  expect((await act(t1, "approve", "ap-ok", A.token)).replayed, "replay");
  expect((await act(t1, "approve", "ap-twice", A.token)).status === 409, "approve twice");

  const ms = await call("POST", `/projects/${projectId}/milestones`, { body: { title: "Final", amountMinor: 100000, currency: "NGN", assignmentId: as1 }, token: A.token, key: k("ms") });
  expect(ms.status === 201, `milestone ${ms.status} ${ms.text}`);
  const open = await act(t1, "complete", "co-open", A.token);
  expect(open.status === 409 && code(open) === "milestones_open" && open.json.error.details.openCount === 1, `open milestone ${open.status} ${open.text}`);
  const id = ms.json.milestone.id as string;
  await forceFunded(id);
  expect((await call("POST", `/milestones/${id}/submit`, { body: {}, token: P1.token, key: k("ms-sub") })).status === 200, "milestone submit while the assignment is active");
  expect((await call("POST", `/milestones/${id}/approve`, { body: {}, token: A.token, key: k("ms-ap") })).status === 200, "milestone approve");

  const done = await act(t1, "complete", "co-ok", A.token);
  expect(done.status === 200 && done.json.task.status === "completed" && done.json.task.actualEnd, `complete ${done.status} ${done.text}`);
  expect((await act(t1, "complete", "co-ok", A.token)).replayed, "replay");
  expect((await act(t1, "complete", "co-twice", A.token)).status === 409, "complete twice");
  expect(await taskStatus(t1) === "completed", "task row is completed");
  const list = await call("GET", "/assignments?status=completed", { token: P1.token });
  expect(list.json.assignments.some((a: any) => a.id === as1), "assignment is completed");
});

test("dependency released: t3 can start once t1 is completed", async () => {
  const ok = await act(t3, "start", "st-t3", P1.token);
  expect(ok.status === 200 && ok.json.task.status === "in_progress", `t3 ${ok.status} ${ok.text}`);
});

test("activity: one event per step; refused calls add nothing", async () => {
  const ev = await db.select({ t: activityEvents.eventType }).from(activityEvents).where(eq(activityEvents.projectId, projectId));
  const n = (type: string) => ev.filter((e) => e.t === type).length;
  const want: Array<[string, number]> = [
    ["task.started", 2], ["task.submitted", 2], ["task.changes_requested", 1], ["task.approved", 1], ["task.completed", 1],
  ];
  for (const [type, count] of want) expect(n(type) === count, `${type} x${n(type)} (want ${count})`);
  const byStranger = await db.select({ id: activityEvents.id }).from(activityEvents).where(eq(activityEvents.actorUserId, S.id));
  expect(byStranger.length === 0, "the stranger changed nothing");
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
