import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { activityEvents, evidence, projectMembers } from "../db/schema/index.js";
import { canTransition, MILESTONE_TRANSITIONS } from "../engine/state-machines.js";
import { call, cleanupTestUsers, createProject, expect, registerProvider, registerUser } from "./test-helpers.js";
import { forceFunded } from "./test-fund.js";

// Milestones and evidence metadata (DECISIONS D37-D40). Needs `npm run db:seed`. Run: npm run test:milestones
const stamp = Date.now().toString(36);
const LIKE = "mstest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;
const code = (r: { json: any }) => r.json?.error?.code;
const sha = "a".repeat(64);

let A = { token: "", id: "" }; // project owner (default approver)
let S = { token: "", id: "" }; // stranger
let I = { token: "", id: "" }; // inspector member
let F = { token: "", id: "" }; // finance approver member
let P1 = { token: "", id: "", providerId: "" };
let P2 = { token: "", id: "", providerId: "" };
let projectId = "";
let t1 = "";
let as1 = "";
let as2 = "";
let m1 = ""; // as1, 300000, needs 2 x photo_after
let m2 = ""; // as1, 200000, no requirements
let m3 = ""; // as2, 100000
let m4 = ""; // no assignment
let m5 = ""; // as2, 100000, approver F

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);
const path = (n: string) => `projects/${projectId}/${n}-${stamp}.jpg`;

const quoteBody = () => ({
  currency: "NGN",
  validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  lines: [{ kind: "labour", description: "Work", quantity: 1, unitPriceMinor: 500000 }],
});

/** invite -> quote -> submit -> accept -> provider accepts the assignment. Returns the assignment id. */
async function award(task: string, p: { token: string; providerId: string }, tag: string): Promise<string> {
  const inv = await call("POST", `/tasks/${task}/invitations`, { body: { providerProfileId: p.providerId }, token: A.token, key: k(`i-${tag}`) });
  expect(inv.status === 201, `invite ${tag} ${inv.status} ${inv.text}`);
  const q = await call("POST", `/tasks/${task}/quotes`, { body: quoteBody(), token: p.token, key: k(`q-${tag}`) });
  expect(q.status === 201, `quote ${tag} ${q.status} ${q.text}`);
  expect((await call("POST", `/quotes/${q.json.quote.id}/submit`, { body: {}, token: p.token, key: k(`s-${tag}`) })).status === 200, `submit ${tag}`);
  const acc = await call("POST", `/quotes/${q.json.quote.id}/accept`, { body: {}, token: A.token, key: k(`a-${tag}`) });
  expect(acc.status === 200, `accept quote ${tag} ${acc.status} ${acc.text}`);
  const id = acc.json.assignment.id as string;
  const resp = await call("POST", `/assignments/${id}/accept`, { body: {}, token: p.token, key: k(`aa-${tag}`) });
  expect(resp.status === 200, `accept assignment ${tag} ${resp.status} ${resp.text}`);
  return id;
}

const create = (body: unknown, key: string, token = A.token) =>
  call("POST", `/projects/${projectId}/milestones`, { body, token, key: k(key) });

test("pure: milestone state machine", async () => {
  expect(canTransition(MILESTONE_TRANSITIONS, "pending", "submitted"), "pending -> submitted");
  expect(canTransition(MILESTONE_TRANSITIONS, "submitted", "approved"), "submitted -> approved");
  expect(canTransition(MILESTONE_TRANSITIONS, "submitted", "in_progress"), "changes requested");
  expect(!canTransition(MILESTONE_TRANSITIONS, "pending", "approved"), "cannot approve unsubmitted work");
  expect(!canTransition(MILESTONE_TRANSITIONS, "cancelled", "pending"), "cancelled is terminal");
});

test("setup: owner, stranger, inspector, finance approver, two awarded providers", async () => {
  A = await registerUser(`mstest-${stamp}-a@test.invalid`);
  S = await registerUser(`mstest-${stamp}-s@test.invalid`);
  I = await registerUser(`mstest-${stamp}-i@test.invalid`);
  F = await registerUser(`mstest-${stamp}-f@test.invalid`);
  P1 = await registerProvider(`mstest-${stamp}-p1@test.invalid`, `p1-${stamp}`);
  P2 = await registerProvider(`mstest-${stamp}-p2@test.invalid`, `p2-${stamp}`);
  const p = await createProject(A.token, `ma-${stamp}`, "Fix the leaking tap");
  projectId = p.projectId; t1 = p.taskId;
  await db.insert(projectMembers).values([
    { projectId, userId: I.id, role: "inspector" },
    { projectId, userId: F.id, role: "finance_approver" },
  ]);
  const second = await call("POST", `/projects/${projectId}/tasks`, { body: { title: "Repaint ceiling" }, token: A.token, key: k("t2") });
  expect(second.status === 201, `second task ${second.status}`);
  const t2 = second.json.task.id as string;
  for (const [t, key] of [[t1, "r1"], [t2, "r2"]] as const) {
    expect((await call("POST", `/tasks/${t}/transition`, { body: { to: "ready" }, token: A.token, key: k(key) })).status === 200, `ready ${key}`);
  }
  as1 = await award(t1, P1, "p1");
  as2 = await award(t2, P2, "p2");
});

test("create: permissions, validation, quote cap, replay", async () => {
  const body = { title: "Rough-in", amountMinor: 300000, currency: "NGN", assignmentId: as1, acceptanceCriteria: "No leaks", evidenceRequirements: { minCount: 2, kinds: ["photo_after"] } };
  expect((await call("POST", `/projects/${projectId}/milestones`, { body })).status === 401, "401");
  const noKey = await call("POST", `/projects/${projectId}/milestones`, { body, token: A.token });
  expect(noKey.status === 400 && code(noKey) === "idempotency_key_required", `no key ${noKey.status}`);
  const asProvider = await create(body, "c-prov2", P1.token);
  expect(asProvider.status === 403, `provider create ${asProvider.status}`);
  expect((await create(body, "c-stranger", S.token)).status === 404, "stranger 404");
  const bad = async (patch: Record<string, unknown>, key: string, want: number, wantCode?: string) => {
    const r = await create({ ...body, ...patch }, key);
    expect(r.status === want && (!wantCode || code(r) === wantCode), `${key}: ${r.status} ${r.text}`);
  };
  await bad({ currency: "USD" }, "c-cur", 400, "currency_mismatch");
  await bad({ amountMinor: 0 }, "c-zero", 400);
  await bad({ amountMinor: 1.5 }, "c-frac", 400);
  await bad({ hack: 1 }, "c-extra", 400);
  await bad({ assignmentId: "00000000-0000-4000-8000-000000000000" }, "c-asg", 400, "assignment_invalid");
  await bad({ stageId: "00000000-0000-4000-8000-000000000000" }, "c-stage", 400, "stage_invalid");
  await bad({ approverUserId: P1.id }, "c-approver", 400, "approver_invalid");
  await bad({ evidenceRequirements: { minCount: 99 } }, "c-minc", 400);

  const ok = await create(body, "c-m1");
  expect(ok.status === 201, `create ${ok.status} ${ok.text}`);
  const m = ok.json.milestone;
  expect(m.status === "pending" && m.approverUserId === A.id && m.position === 0 && m.amountMinor === 300000, `m1 ${JSON.stringify(m)}`);
  expect(m.evidenceRequirements.minCount === 2 && m.evidenceRequirements.kinds[0] === "photo_after", "requirements stored");
  m1 = m.id;
  const replay = await create(body, "c-m1");
  expect(replay.status === 201 && replay.replayed && replay.json.milestone.id === m1, "replay returns the same milestone");

  const r2 = await create({ title: "Finish", amountMinor: 200000, currency: "NGN", assignmentId: as1 }, "c-m2");
  expect(r2.status === 201 && r2.json.milestone.position === 1, `m2 ${r2.status} ${r2.text}`);
  m2 = r2.json.milestone.id;
  const over = await create({ title: "Extra", amountMinor: 1, currency: "NGN", assignmentId: as1 }, "c-over");
  expect(over.status === 409 && code(over) === "milestones_exceed_quote" && over.json.error.details.remainingMinor === 0, `over ${over.status} ${over.text}`);

  const r3 = await create({ title: "Paint", amountMinor: 100000, currency: "NGN", assignmentId: as2 }, "c-m3");
  expect(r3.status === 201, `m3 ${r3.text}`); m3 = r3.json.milestone.id;
  const r4 = await create({ title: "Project-level", amountMinor: 50000, currency: "NGN" }, "c-m4");
  expect(r4.status === 201 && r4.json.milestone.assignmentId === null, `m4 ${r4.text}`); m4 = r4.json.milestone.id;
  const r5 = await create({ title: "Paint 2", amountMinor: 100000, currency: "NGN", assignmentId: as2, approverUserId: F.id }, "c-m5");
  expect(r5.status === 201 && r5.json.milestone.approverUserId === F.id, `m5 ${r5.text}`); m5 = r5.json.milestone.id;
});

test("read: owners see all, providers only their own, strangers nothing", async () => {
  const own = await call("GET", `/projects/${projectId}/milestones`, { token: A.token });
  expect(own.status === 200 && own.json.milestones.length === 5, `owner list ${own.status} ${own.text}`);
  const p1 = await call("GET", `/projects/${projectId}/milestones`, { token: P1.token });
  const ids1 = p1.json.milestones.map((m: any) => m.id).sort();
  expect(p1.status === 200 && ids1.join() === [m1, m2].sort().join(), `P1 list ${p1.text}`);
  const p2 = await call("GET", `/projects/${projectId}/milestones`, { token: P2.token });
  expect(p2.json.milestones.map((m: any) => m.id).sort().join() === [m3, m5].sort().join(), `P2 list ${p2.text}`);
  expect((await call("GET", `/projects/${projectId}/milestones`, { token: S.token })).status === 404, "stranger list 404");
  const one = await call("GET", `/milestones/${m1}`, { token: P1.token });
  expect(one.status === 200 && one.json.evidenceProgress.required === 2 && one.json.evidenceProgress.have === 0, `get ${one.text}`);
  expect((await call("GET", `/milestones/${m3}`, { token: P1.token })).status === 404, "P1 cannot see P2's milestone");
  expect((await call("GET", `/milestones/${m4}`, { token: P1.token })).status === 404, "P1 cannot see a project-level milestone");
  expect((await call("GET", `/milestones/${m1}`, { token: S.token })).status === 404, "stranger 404");
  expect((await call("GET", "/milestones/not-a-uuid", { token: A.token })).status === 404, "malformed id 404");
});

test("evidence: content rules, who may add, replay, kind filter", async () => {
  const ev = (id: string, body: unknown, key: string, token: string, what: "milestones" | "tasks" = "milestones") =>
    call("POST", `/${what}/${id}/evidence`, { body, token, key: k(key) });
  const good = { kind: "photo_after", storagePath: path("a1"), mimeType: "image/jpeg", sizeBytes: 1234, fileSha256: sha, capturedAt: new Date().toISOString() };
  const bad = async (patch: Record<string, unknown>, key: string) => {
    const r = await ev(m1, { ...good, ...patch }, key, P1.token);
    expect(r.status === 400, `${key} expected 400 got ${r.status} ${r.text}`);
  };
  await bad({ storagePath: undefined }, "e-nopath");
  await bad({ storagePath: `projects/00000000-0000-4000-8000-000000000000/x.jpg` }, "e-otherproj");
  await bad({ storagePath: `projects/${projectId}/../x.jpg` }, "e-dots");
  await bad({ fileSha256: "xyz" }, "e-sha");
  await bad({ capturedAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }, "e-future");
  await bad({ hack: 1 }, "e-extra");
  await bad({ kind: "nonsense" }, "e-kind");
  const noMeta = await ev(m1, { kind: "checklist" }, "e-nometa", P1.token);
  expect(noMeta.status === 400 && code(noMeta) === "evidence_invalid", `checklist without meta ${noMeta.status}`);

  expect((await ev(m1, good, "w-owner", A.token)).status === 403, "owner cannot add evidence");
  expect((await ev(m1, good, "w-stranger", S.token)).status === 404, "stranger 404");
  expect((await ev(m1, good, "w-p2", P2.token)).status === 404, "another provider 404");
  expect((await ev(m4, good, "w-p1-m4", P1.token)).status === 404, "P1 on a milestone with no assignment 404");

  const before = await ev(m1, { ...good, kind: "photo_before", storagePath: path("b0") }, "w-before", P1.token);
  expect(before.status === 201 && before.json.evidence.uploaderUserId === P1.id && before.json.evidence.milestoneId === m1, `before ${before.text}`);
  const one = await ev(m1, good, "w-a1", P1.token);
  expect(one.status === 201, `a1 ${one.status} ${one.text}`);
  const replay = await ev(m1, good, "w-a1", P1.token);
  expect(replay.status === 201 && replay.replayed && replay.json.evidence.id === one.json.evidence.id, "replay returns the same evidence");
  const progress = await call("GET", `/milestones/${m1}`, { token: P1.token });
  expect(progress.json.evidenceProgress.have === 1, `only photo_after counts toward the requirement: ${JSON.stringify(progress.json.evidenceProgress)}`);

  const insp = await ev(m2, { kind: "checklist", captureMeta: { items: ["valves closed", "no leaks"] } }, "w-insp", I.token);
  expect(insp.status === 201, `inspector ${insp.status} ${insp.text}`);

  const tp = await ev(t1, { kind: "photo_progress", storagePath: path("t1") }, "w-task", P1.token, "tasks");
  expect(tp.status === 201 && tp.json.evidence.taskId === t1, `task evidence ${tp.status} ${tp.text}`);
  expect((await ev(t1, { kind: "photo_progress", storagePath: path("t2") }, "w-task-owner", A.token, "tasks")).status === 403, "owner cannot add task evidence");
  expect((await ev(t1, { kind: "photo_progress", storagePath: path("t3") }, "w-task-p2", P2.token, "tasks")).status === 404, "other provider 404");

  const list = await call("GET", `/tasks/${t1}/evidence`, { token: A.token });
  expect(list.status === 200 && list.json.evidence.length === 1, `task evidence list ${list.text}`);
  expect((await call("GET", `/tasks/${t1}/evidence`, { token: P2.token })).status === 404, "P2 cannot read t1 evidence");
  expect((await call("GET", `/tasks/${t1}/evidence`, { token: S.token })).status === 404, "stranger cannot read");
  const mlist = await call("GET", `/milestones/${m1}/evidence`, { token: A.token });
  expect(mlist.status === 200 && mlist.json.evidence.length === 2, `milestone evidence list ${mlist.text}`);
  expect((await call("GET", `/milestones/${m1}/evidence`, { token: P2.token })).status === 404, "P2 cannot read m1 evidence");
});

test("submit: only the assigned provider, evidence requirement enforced, then frozen", async () => {
  const sub = (id: string, key: string, token: string, body: unknown = {}) => call("POST", `/milestones/${id}/submit`, { body, token, key: k(key) });
  expect((await sub(m1, "s-owner", A.token)).status === 403, "owner cannot submit");
  expect((await sub(m1, "s-stranger", S.token)).status === 404, "stranger 404");
  expect((await sub(m1, "s-p2", P2.token)).status === 404, "other provider 404");
  expect((await sub(m4, "s-m4", P1.token)).status === 404, "no-assignment milestone 404 for a provider");
  const unfunded = await sub(m1, "s-unfunded", P1.token);
  expect(unfunded.status === 409 && code(unfunded) === "milestone_not_funded", `unfunded ${unfunded.status} ${unfunded.text}`);
  await forceFunded(m1);
  const short = await sub(m1, "s-short", P1.token);
  expect(short.status === 409 && code(short) === "evidence_requirements_not_met" && short.json.error.details.have === 1, `short ${short.status} ${short.text}`);

  const more = await call("POST", `/milestones/${m1}/evidence`, { body: { kind: "photo_after", storagePath: path("a2"), fileSha256: sha }, token: P1.token, key: k("w-a2") });
  expect(more.status === 201, `a2 ${more.text}`);
  const ok = await sub(m1, "s-ok", P1.token, { note: "All done" });
  expect(ok.status === 200 && ok.json.milestone.status === "submitted", `submit ${ok.status} ${ok.text}`);
  const replay = await sub(m1, "s-ok", P1.token, { note: "All done" });
  expect(replay.status === 200 && replay.replayed, "replay");
  const again = await sub(m1, "s-again", P1.token);
  expect(again.status === 409 && code(again) === "illegal_transition", `second submit ${again.status}`);
  const late = await call("POST", `/milestones/${m1}/evidence`, { body: { kind: "photo_after", storagePath: path("a3") }, token: P1.token, key: k("w-late") });
  expect(late.status === 409 && code(late) === "milestone_not_open_for_evidence", `late evidence ${late.status}`);
});

test("approve: only the named approver; unsubmitted work cannot be approved", async () => {
  const app = (id: string, key: string, token: string) => call("POST", `/milestones/${id}/approve`, { body: {}, token, key: k(key) });
  expect((await app(m1, "ap-p1", P1.token)).status === 404, "provider-only members cannot even see approval");
  expect((await app(m1, "ap-stranger", S.token)).status === 404, "stranger 404");
  expect((await app(m1, "ap-fin", F.token)).status === 403, "finance approver is not the approver of m1");
  const early = await app(m2, "ap-early", A.token);
  expect(early.status === 409 && code(early) === "illegal_transition", `unsubmitted ${early.status}`);
  const ok = await app(m1, "ap-ok", A.token);
  expect(ok.status === 200 && ok.json.milestone.status === "approved" && ok.json.milestone.approvedAt, `approve ${ok.status} ${ok.text}`);
  expect((await app(m1, "ap-ok", A.token)).replayed, "replay");
  const twice = await app(m1, "ap-twice", A.token);
  expect(twice.status === 409, `second approve ${twice.status}`);
});

test("changes requested: back to in_progress, resubmit, approve", async () => {
  await forceFunded(m2);
  const sub = (key: string) => call("POST", `/milestones/${m2}/submit`, { body: {}, token: P1.token, key: k(key) });
  expect((await sub("m2-s1")).status === 200, "first submit (no requirement)");
  const noReason = await call("POST", `/milestones/${m2}/request-changes`, { body: {}, token: A.token, key: k("rc-0") });
  expect(noReason.status === 400, `no reason ${noReason.status}`);
  const asProvider = await call("POST", `/milestones/${m2}/request-changes`, { body: { reason: "x" }, token: P1.token, key: k("rc-p") });
  expect(asProvider.status === 404, `provider ${asProvider.status}`);
  const rc = await call("POST", `/milestones/${m2}/request-changes`, { body: { reason: "Photo of the valve please" }, token: A.token, key: k("rc-1") });
  expect(rc.status === 200 && rc.json.milestone.status === "in_progress", `request changes ${rc.status} ${rc.text}`);
  const extra = await call("POST", `/milestones/${m2}/evidence`, { body: { kind: "photo_after", storagePath: path("v1") }, token: P1.token, key: k("w-v1") });
  expect(extra.status === 201, `evidence while in_progress ${extra.status}`);
  expect((await sub("m2-s2")).status === 200, "resubmit");
  const ap = await call("POST", `/milestones/${m2}/approve`, { body: {}, token: A.token, key: k("ap-m2") });
  expect(ap.status === 200, `approve m2 ${ap.status}`);
});

test("custom approver: finance approver approves, the owner may not", async () => {
  await forceFunded(m5);
  expect((await call("POST", `/milestones/${m5}/submit`, { body: {}, token: P2.token, key: k("m5-s") })).status === 200, "P2 submits m5");
  const byOwner = await call("POST", `/milestones/${m5}/approve`, { body: {}, token: A.token, key: k("m5-ap-owner") });
  expect(byOwner.status === 403 && code(byOwner) === "not_approver", `owner ${byOwner.status} ${byOwner.text}`);
  const byFin = await call("POST", `/milestones/${m5}/approve`, { body: {}, token: F.token, key: k("m5-ap-fin") });
  expect(byFin.status === 200 && byFin.json.milestone.status === "approved", `finance ${byFin.status} ${byFin.text}`);
});

test("activity and storage: one event per step; refused calls leave nothing", async () => {
  const ev = await db.select({ t: activityEvents.eventType }).from(activityEvents).where(eq(activityEvents.projectId, projectId));
  const n = (type: string) => ev.filter((e) => e.t === type).length;
  const want: Array<[string, number]> = [
    ["milestone.created", 5], ["milestone.submitted", 4], ["milestone.approved", 3], ["milestone.changes_requested", 1],
    ["evidence.added", 6], // m1: before + 2 after; m2: inspector checklist + P1 photo; task: 1
  ];
  for (const [type, count] of want) expect(n(type) === count, `${type} x${n(type)} (want ${count})`);
  const rows = await db.select({ id: evidence.id }).from(evidence).where(eq(evidence.projectId, projectId));
  expect(rows.length === 6, `evidence rows ${rows.length}`);
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
