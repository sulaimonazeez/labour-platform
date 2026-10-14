import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { activityEvents, projectMembers } from "../db/schema/index.js";
import { wouldCreateCycle } from "../engine/dependencies.js";
import { call, cleanupTestUsers, createProject, expect, registerUser } from "./test-helpers.js";

// Tasks, dependencies, transitions. Needs `npm run db:seed`. Run: npm run test:tasks
const stamp = Date.now().toString(36);
const LIKE = "tasktest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;

let A = { token: "", id: "" }; // project owner
let B = { token: "", id: "" }; // observer member
let C = { token: "", id: "" }; // stranger
let projectId = "";
let stageId = "";
let t1 = ""; // first task (created by convert)
let t2 = "";
let t3 = "";
let otherProjectTask = "";

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("pure: wouldCreateCycle", async () => {
  const e = [{ taskId: "b", dependsOnTaskId: "a" }, { taskId: "c", dependsOnTaskId: "b" }];
  expect(wouldCreateCycle(e, "a", "a"), "self dependency must be a cycle");
  expect(wouldCreateCycle(e, "a", "c"), "a->c closes a->c->b->a");
  expect(wouldCreateCycle(e, "a", "b"), "a->b closes a->b->a");
  expect(!wouldCreateCycle(e, "c", "a"), "c->a is fine (c already reaches a)");
  expect(!wouldCreateCycle(e, "d", "c"), "unrelated task is fine");
  const diamond = [{ taskId: "d", dependsOnTaskId: "b" }, { taskId: "d", dependsOnTaskId: "c" }, { taskId: "b", dependsOnTaskId: "a" }, { taskId: "c", dependsOnTaskId: "a" }];
  expect(!wouldCreateCycle(diamond, "e", "d"), "diamond must not loop forever or false-positive");
});

test("setup: owner, observer, stranger, project", async () => {
  A = await registerUser(`tasktest-${stamp}-a@test.invalid`);
  B = await registerUser(`tasktest-${stamp}-b@test.invalid`);
  C = await registerUser(`tasktest-${stamp}-c@test.invalid`);
  const p = await createProject(A.token, `a1-${stamp}`, "Main project");
  projectId = p.projectId; stageId = p.stageId; t1 = p.taskId;
  await db.insert(projectMembers).values({ projectId, userId: B.id, role: "observer" });
  otherProjectTask = (await createProject(A.token, `a2-${stamp}`, "Other project")).taskId;
});

test("create task: 401, key required, non-member 404, observer 403", async () => {
  const body = { title: "Second task" };
  expect((await call("POST", `/projects/${projectId}/tasks`, { body, key: k("ct-noauth") })).status === 401, "no token should be 401");
  const nokey = await call("POST", `/projects/${projectId}/tasks`, { body, token: A.token });
  expect(nokey.status === 400 && nokey.json?.error?.code === "idempotency_key_required", `nokey ${nokey.status}`);
  expect((await call("POST", `/projects/${projectId}/tasks`, { body, token: C.token, key: k("ct-stranger") })).status === 404, "stranger should be 404");
  expect((await call("POST", `/projects/${projectId}/tasks`, { body, token: B.token, key: k("ct-observer") })).status === 403, "observer should be 403");
});

test("create task: validation", async () => {
  const p = `/projects/${projectId}/tasks`;
  const a = await call("POST", p, { body: {}, token: A.token, key: k("ct-v-empty") });
  expect(a.status === 400 && a.json?.error?.code === "validation_error", `empty ${a.status}`);
  const b = await call("POST", p, { body: { title: "x", projectId }, token: A.token, key: k("ct-v-extra") });
  expect(b.status === 400, `unknown field accepted ${b.status}`);
  const c = await call("POST", p, { body: { title: "x", stageId: "00000000-0000-4000-8000-000000000000" }, token: A.token, key: k("ct-v-stage") });
  expect(c.status === 400 && c.json?.error?.code === "unknown_stage", `stage ${c.status} ${c.text}`);
  const d = await call("POST", p, { body: { title: "x", categoryKey: "nope" }, token: A.token, key: k("ct-v-cat1") });
  expect(d.status === 400 && d.json?.error?.code === "unknown_category", `category ${d.status}`);
});

test("create task: success, default stage, next position, replay", async () => {
  const p = `/projects/${projectId}/tasks`;
  const r = await call("POST", p, { body: { title: "Second task", categoryKey: "plumbing_residential", materialResponsibility: "provider" }, token: A.token, key: k("ct-main") });
  expect(r.status === 201, `got ${r.status} ${r.text}`);
  expect(r.json.task.status === "draft" && r.json.task.position === 1 && r.json.task.stageId === stageId, `task: ${JSON.stringify(r.json.task)}`);
  expect(r.json.task.materialResponsibility === "provider" && r.json.task.categoryId, "material/category not stored");
  t2 = r.json.task.id;
  const again = await call("POST", p, { body: { title: "Second task", categoryKey: "plumbing_residential", materialResponsibility: "provider" }, token: A.token, key: k("ct-main") });
  expect(again.status === 201 && again.replayed && again.json.task.id === t2, `replay ${again.status}`);
  const r3 = await call("POST", p, { body: { title: "Third task" }, token: A.token, key: k("ct-third") });
  expect(r3.status === 201 && r3.json.task.position === 2, `third ${r3.status} ${r3.text}`);
  t3 = r3.json.task.id;
});

test("GET task: member 200 (incl. observer), stranger 404, malformed id 404", async () => {
  expect((await call("GET", `/tasks/${t2}`, { token: A.token })).status === 200, "owner");
  expect((await call("GET", `/tasks/${t2}`, { token: B.token })).status === 200, "observer");
  expect((await call("GET", `/tasks/${t2}`, { token: C.token })).status === 404, "stranger");
  expect((await call("GET", `/tasks/nope`, { token: A.token })).status === 404, "malformed");
});

test("dependencies: add, duplicate, cycles, cross-project, permissions", async () => {
  const dep = (task: string, on: string, token = A.token, key = "") =>
    call("POST", `/tasks/${task}/dependencies`, { body: { dependsOnTaskId: on }, token, key: key || k(`d-${task.slice(0, 4)}-${on.slice(0, 4)}-${Math.random().toString(36).slice(2, 6)}`) });
  const ok = await dep(t2, t1);
  expect(ok.status === 201 && ok.json.dependency.type === "finish_to_start", `add ${ok.status} ${ok.text}`);
  const dup = await dep(t2, t1);
  expect(dup.status === 409 && dup.json?.error?.code === "dependency_exists", `dup ${dup.status} ${dup.text}`);
  const self = await dep(t2, t2);
  expect(self.status === 409 && self.json?.error?.code === "dependency_cycle", `self ${self.status}`);
  const back = await dep(t1, t2);
  expect(back.status === 409 && back.json?.error?.code === "dependency_cycle", `back ${back.status}`);
  expect((await dep(t3, t2)).status === 201, "t3 depends on t2 should work");
  const loop = await dep(t1, t3);
  expect(loop.status === 409 && loop.json?.error?.code === "dependency_cycle", `3-step loop ${loop.status}`);
  const cross = await dep(t2, otherProjectTask);
  expect(cross.status === 400 && cross.json?.error?.code === "dependency_invalid", `cross-project ${cross.status} ${cross.text}`);
  expect((await dep(t3, t1, B.token)).status === 403, "observer should be 403");
  expect((await dep(t3, t1, C.token)).status === 404, "stranger should be 404");
  const d = await call("GET", `/tasks/${t2}`, { token: A.token });
  expect(d.json.dependsOn.length === 1 && d.json.blocks.length === 1, `detail: ${d.text}`);
});

test("transition: manual moves work; illegal and reserved moves are refused", async () => {
  const go = (task: string, to: string, key: string, token = A.token) => call("POST", `/tasks/${task}/transition`, { body: { to }, token, key: k(key) });
  const ready = await go(t1, "ready", "tr-ready");
  expect(ready.status === 200 && ready.json.task.status === "ready", `ready ${ready.status} ${ready.text}`);
  const illegal = await go(t1, "in_progress", "tr-illegal");
  expect(illegal.status === 409 && illegal.json?.error?.code === "illegal_transition", `illegal ${illegal.status} ${illegal.text}`);
  const reserved = await go(t1, "offered", "tr-reserved");
  expect(reserved.status === 403 && reserved.json?.error?.code === "transition_reserved", `reserved ${reserved.status} ${reserved.text}`);
  expect((await go(t1, "blocked", "tr-block")).json?.task?.status === "blocked", "ready->blocked");
  expect((await go(t1, "ready", "tr-unblock")).json?.task?.status === "ready", "blocked->ready");
  const same = await go(t1, "ready", "tr-same");
  expect(same.status === 409, `ready->ready should be 409, got ${same.status}`);
});

test("transition: replay, cancel, terminal state, permissions", async () => {
  const body = { to: "ready" };
  const first = await call("POST", `/tasks/${t3}/transition`, { body, token: A.token, key: k("tr-t3-ready") });
  const again = await call("POST", `/tasks/${t3}/transition`, { body, token: A.token, key: k("tr-t3-ready") });
  expect(first.status === 200 && again.status === 200 && again.replayed, `replay ${first.status}/${again.status}`);
  expect((await call("POST", `/tasks/${t3}/transition`, { body: { to: "cancelled" }, token: B.token, key: k("tr-obs") })).status === 403, "observer");
  expect((await call("POST", `/tasks/${t3}/transition`, { body: { to: "cancelled" }, token: C.token, key: k("tr-str") })).status === 404, "stranger");
  expect((await call("POST", `/tasks/${t3}/transition`, { body: { to: "cancelled" }, token: A.token, key: k("tr-cancel") })).json?.task?.status === "cancelled", "ready->cancelled");
  const dead = await call("POST", `/tasks/${t3}/transition`, { body: { to: "ready" }, token: A.token, key: k("tr-dead") });
  expect(dead.status === 409 && dead.json?.error?.code === "illegal_transition", `cancelled->ready ${dead.status}`);
  const bad = await call("POST", `/tasks/${t3}/transition`, { body: { to: "flying" }, token: A.token, key: k("tr-badval") });
  expect(bad.status === 400, `unknown status ${bad.status}`);
});

test("activity: task.created, task.dependency_added and task.transitioned are recorded", async () => {
  const ev = await db.select({ t: activityEvents.eventType }).from(activityEvents).where(eq(activityEvents.projectId, projectId));
  const count = (type: string) => ev.filter((e) => e.t === type).length;
  expect(count("task.created") === 2, `task.created x${count("task.created")} (want 2: replay must not duplicate)`);
  expect(count("task.dependency_added") === 2, `dependency_added x${count("task.dependency_added")}`);
  expect(count("task.transitioned") === 5, `transitioned x${count("task.transitioned")} (want 5)`);
  const stray = await db.select({ id: activityEvents.id }).from(activityEvents)
    .where(and(eq(activityEvents.projectId, projectId), eq(activityEvents.actorUserId, C.id)));
  expect(stray.length === 0, "refused requests must leave no activity");
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
