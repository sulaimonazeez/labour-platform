import "dotenv/config";
import { queryClient } from "../db/client.js";
import { memoryStorage } from "../lib/storage.js";
import { call, cleanupTestUsers, createProject, expect, registerProvider, registerUser } from "./test-helpers.js";

// Evidence files (upload-url -> PUT -> confirm), the task work actions and the project timeline (D74-D76).
// Needs `npm run db:seed`. Run: npm run test:work  (the script sets STORAGE_DRIVER=memory)
const stamp = Date.now().toString(36);
const LIKE = "wrktest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;
const code = (r: { json: any }) => r.json?.error?.code;

let A = { token: "", id: "" };
let S = { token: "", id: "" };
let P1 = { token: "", id: "", providerId: "" };
let P2 = { token: "", id: "", providerId: "" };
let projectId = "";
let t1 = "";
let t2 = "";

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

async function award(task: string, p: { token: string; providerId: string }, tag: string) {
  expect((await call("POST", `/tasks/${task}/invitations`, { body: { providerProfileId: p.providerId }, token: A.token, key: k(`i-${tag}`) })).status === 201, `invite ${tag}`);
  const q = await call("POST", `/tasks/${task}/quotes`, {
    body: { currency: "NGN", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), lines: [{ kind: "labour", description: "Work", quantity: 1, unitPriceMinor: 500000 }] },
    token: p.token, key: k(`q-${tag}`),
  });
  expect(q.status === 201, `quote ${tag} ${q.status} ${q.text}`);
  expect((await call("POST", `/quotes/${q.json.quote.id}/submit`, { body: {}, token: p.token, key: k(`s-${tag}`) })).status === 200, `submit ${tag}`);
  const acc = await call("POST", `/quotes/${q.json.quote.id}/accept`, { body: {}, token: A.token, key: k(`a-${tag}`) });
  expect(acc.status === 200, `accept ${tag} ${acc.status} ${acc.text}`);
  expect((await call("POST", `/assignments/${acc.json.assignment.id}/accept`, { body: {}, token: p.token, key: k(`aa-${tag}`) })).status === 200, `assignment ${tag}`);
}
const upload = (token: string, task: string, key: string, body: Record<string, unknown>) =>
  call("POST", `/tasks/${task}/evidence/upload-url`, { body, token, key: k(key) });

test("setup: owner, stranger, two providers, two awarded tasks", async () => {
  A = await registerUser(`wrktest-${stamp}-a@test.invalid`);
  S = await registerUser(`wrktest-${stamp}-s@test.invalid`);
  P1 = await registerProvider(`wrktest-${stamp}-p1@test.invalid`, `w1-${stamp}`);
  P2 = await registerProvider(`wrktest-${stamp}-p2@test.invalid`, `w2-${stamp}`);
  const p = await createProject(A.token, `wk-${stamp}`, "Install the shelves");
  projectId = p.projectId; t1 = p.taskId;
  const r = await call("POST", `/projects/${projectId}/tasks`, { body: { title: "Hang the door" }, token: A.token, key: k("mk-t2") });
  expect(r.status === 201, `task 2 ${r.status} ${r.text}`);
  t2 = r.json.task.id;
  for (const t of [t1, t2]) expect((await call("POST", `/tasks/${t}/transition`, { body: { to: "ready" }, token: A.token, key: k(`rd-${t.slice(0, 6)}`) })).status === 200, "ready");
  await award(t1, P1, "p1");
  await award(t2, P2, "p2");
});

test("upload-url: who, what, how big", async () => {
  const body = { kind: "photo_progress", mimeType: "image/jpeg", sizeBytes: 2_000_000 };
  expect((await upload(S.token, t1, "u-s", body)).status === 404, "a stranger gets 404");
  expect((await upload(P2.token, t1, "u-p2", body)).status === 404, "another project provider gets 404 on a task that is not theirs");
  expect((await upload(A.token, t1, "u-a", body)).status === 403, "the owner cannot add evidence (D38)");
  expect(code(await upload(P1.token, t1, "u-mime", { ...body, mimeType: "application/zip" })) === "unsupported_media_type", "mime allowlist");
  expect(code(await upload(P1.token, t1, "u-video-as-photo", { ...body, mimeType: "video/mp4" })) === "unsupported_media_type", "a photo must be an image");
  expect(code(await upload(P1.token, t1, "u-big", { ...body, sizeBytes: 16 * 1024 * 1024 })) === "too_large", "photo size cap");
  expect((await upload(P1.token, t1, "u-zero", { ...body, sizeBytes: 0 })).status === 400, "empty file");
  const ok = await upload(P1.token, t1, "u-ok", body);
  expect(ok.status === 201 && ok.json.storagePath.startsWith(`projects/${projectId}/evidence/`) && ok.json.storagePath.endsWith(".jpg"), `issued ${ok.status} ${ok.text}`);
  expect(ok.json.upload.method === "PUT" && ok.json.upload.url.length > 0, "upload target returned");
});

test("evidence: an issued path must really reach storage; the real size is recorded; links are signed", async () => {
  const up = await upload(P1.token, t1, "e-up", { kind: "photo_before", mimeType: "image/png", sizeBytes: 1_000 });
  const path = up.json.storagePath as string;
  const add = (body: Record<string, unknown>, key: string) => call("POST", `/tasks/${t1}/evidence`, { body, token: P1.token, key: k(key) });
  const missing = await add({ kind: "photo_before", storagePath: path, mimeType: "image/png" }, "e-missing");
  expect(missing.status === 409 && code(missing) === "upload_missing", `not uploaded yet ${missing.status} ${missing.text}`);
  memoryStorage.simulateUpload(path, 123_456);
  const ok = await add({ kind: "photo_before", storagePath: path, mimeType: "image/png", sizeBytes: 5 }, "e-ok");
  expect(ok.status === 201 && ok.json.evidence.sizeBytes === 123_456, `real size wins over the claimed one ${ok.text}`);
  const other = await add({ kind: "photo_before", storagePath: `projects/00000000-0000-4000-8000-000000000000/evidence/${"a".repeat(8)}-aaaa-4aaa-8aaa-${"b".repeat(12)}.png` }, "e-other");
  expect(other.status === 400, "another project's path is refused");
  const legacy = await add({ kind: "document", storagePath: `projects/${projectId}/legacy/spec.pdf`, mimeType: "application/pdf" }, "e-legacy");
  expect(legacy.status === 201, "metadata-only and older paths still work");

  const list = await call("GET", `/tasks/${t1}/evidence`, { token: A.token });
  expect(list.status === 200 && list.json.evidence.length === 2, `owner sees both ${list.text}`);
  expect(list.json.evidence.every((e: any) => typeof e.url === "string" && e.url.includes("ttl=900")), "each file has a short-lived signed link");
  expect((await call("GET", `/tasks/${t1}/evidence`, { token: P2.token })).status === 404, "the other provider cannot list it");
});

test("work flow: start, submit, send back, resubmit, approve, complete", async () => {
  const w = (verb: string, token: string, key: string, body: unknown = {}) => call("POST", `/tasks/${t1}/${verb}`, { body, token, key: k(key) });
  expect((await w("submit", P1.token, "w-early")).status === 409, "cannot submit before starting");
  expect((await w("start", A.token, "w-own")).status === 403 || (await w("start", A.token, "w-own2")).status === 404, "the owner cannot start the provider's work");
  expect((await w("start", P1.token, "w-start")).status === 200, "provider starts");
  expect((await w("submit", P1.token, "w-submit", { note: "All done" })).status === 200, "provider submits");
  expect((await w("approve", P1.token, "w-self")).status === 403, "provider cannot approve their own work");
  const back = await w("request-changes", A.token, "w-back", { reason: "Door still sticks" });
  expect(back.status === 200 && back.json.task.status === "in_progress", `sent back ${back.text}`);
  expect((await w("request-changes", A.token, "w-back2", {})).status === 400, "a reason is required");
  expect((await w("submit", P1.token, "w-resubmit")).status === 200, "provider resubmits");
  expect((await w("approve", A.token, "w-approve")).status === 200, "owner approves");
  const done = await w("complete", A.token, "w-complete");
  expect(done.status === 200 && done.json.task.status === "completed", `complete ${done.status} ${done.text}`);
  const late = await upload(P1.token, t1, "u-late", { kind: "photo_after", mimeType: "image/jpeg", sizeBytes: 1000 });
  expect(late.status === 404 || code(late) === "task_not_open_for_evidence", `no new evidence after completion (${late.status} ${late.text})`);
});

test("timeline: owner sees everything, a provider only their own work, strangers nothing", async () => {
  const mgr = await call("GET", `/projects/${projectId}/activity?limit=100`, { token: A.token });
  expect(mgr.status === 200 && Array.isArray(mgr.json.events), `owner timeline ${mgr.status} ${mgr.text}`);
  const types = mgr.json.events.map((e: any) => e.eventType as string);
  for (const want of ["task.started", "task.submitted", "task.changes_requested", "task.approved", "task.completed", "evidence.added", "quote.accepted"]) {
    expect(types.includes(want), `owner timeline has ${want} (${[...new Set(types)].join(", ")})`);
  }
  const ts = mgr.json.events.map((e: any) => Date.parse(e.occurredAt));
  expect(ts.every((t: number, i: number) => i === 0 || ts[i - 1] >= t), "newest first");

  const p1 = await call("GET", `/projects/${projectId}/activity?limit=100`, { token: P1.token });
  expect(p1.status === 200 && p1.json.events.some((e: any) => e.eventType === "task.completed"), "P1 sees their task finish");
  const p2 = await call("GET", `/projects/${projectId}/activity?limit=100`, { token: P2.token });
  const p2types = p2.json.events.map((e: any) => `${e.eventType}:${e.subjectId}`);
  expect(p2.status === 200 && !p2types.some((t: string) => t.includes(t1)), "P2 never sees events about P1's task");
  expect((await call("GET", `/projects/${projectId}/activity`, { token: S.token })).status === 404, "stranger 404");

  const page1 = await call("GET", `/projects/${projectId}/activity?limit=2`, { token: A.token });
  expect(page1.json.events.length === 2 && typeof page1.json.nextBefore === "string", "paging gives a cursor");
  const page2 = await call("GET", `/projects/${projectId}/activity?limit=2&before=${encodeURIComponent(page1.json.nextBefore)}`, { token: A.token });
  expect(page2.status === 200 && page2.json.events.length > 0 && !page2.json.events.some((e: any) => page1.json.events.some((f: any) => f.id === e.id)), "page 2 does not repeat page 1");
  expect((await call("GET", `/projects/${projectId}/activity?limit=0`, { token: A.token })).status === 400, "limit must be 1 to 100");
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
