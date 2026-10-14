import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client";
import { activityEvents, requestAttachments } from "../db/schema";
import { memoryStorage } from "../lib/storage";
import { missingRequired, questionsFor, safetyFlags, validateAnswers } from "../engine/intake-questions";
import { call, cleanupTestUsers, expect, registerUser } from "./test-helpers";

// Intake: guided questions, answers, photo/video attachments. Uses in-memory storage (no Supabase needed).
// Needs `npm run db:seed` and the intake migration. Run: npm run test:intake  (the script sets STORAGE_DRIVER=memory and a limit of 3 files)
const stamp = Date.now().toString(36);
const LIKE = "intaketest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;
const MB = 1024 * 1024;

let A = { token: "", id: "" };
let B = { token: "", id: "" };
let rE = ""; // request with a category (electrical)
let rG = ""; // request without a category
let att1 = ""; let att1Key = "";
let saves = 0; // successful, non-replayed PUT /answers calls

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);
const code = (r: { json: any }) => r.json?.error?.code;

const upload = (req: string, token: string, body: unknown, key: string) => call("POST", `/requests/${req}/attachments/upload-url`, { body, token, key: k(key) });
const put = (req: string, token: string, answers: unknown, key: string) => call("PUT", `/requests/${req}/answers`, { body: { answers }, token, key: k(key) });

test("pure: question sets, validation, safety flags", async () => {
  const qs = questionsFor("electrical_residential_installation");
  expect(qs[0].key === "burning_or_sparks" && qs[0].safetyWhen === true, "the safety question must come first");
  expect(questionsFor(null).length === 3 && questionsFor("no_such_category").length === 3, "unknown category falls back to the common questions");
  expect(missingRequired(qs, {}).length === 4, `required: ${missingRequired(qs, {})}`);
  const bad = validateAnswers(qs, { nope: 1, fault_scope: "banana", burning_or_sparks: "no", details: "   " });
  expect(!bad.ok && bad.errors.length === 4, `errors: ${JSON.stringify(bad)}`);
  const good = validateAnswers(qs, { urgency: "today", details: "  hi  ", burning_or_sparks: true });
  expect(good.ok && good.clean.details === "hi", "text is trimmed");
  expect(good.ok && safetyFlags(qs, good.clean).join() === "burning_or_sparks", "yes to burning/sparks is a safety flag");
});

test("setup: two users, a categorised request and a plain one", async () => {
  A = await registerUser(`intaketest-${stamp}-a@test.invalid`);
  B = await registerUser(`intaketest-${stamp}-b@test.invalid`);
  const e = await call("POST", "/requests", { body: { rawText: "The room has no power", categoryKey: "electrical_residential_installation", status: "open" }, token: A.token, key: k("rq-e") });
  expect(e.status === 201, `electrical request ${e.status} ${e.text}`);
  rE = e.json.request.id;
  const g = await call("POST", "/requests", { body: { rawText: "Something is wrong in my kitchen" }, token: A.token, key: k("rq-g") });
  expect(g.status === 201, `plain request ${g.status} ${g.text}`);
  rG = g.json.request.id;
});

test("questions: owner only; category sets; nothing answered yet", async () => {
  expect((await call("GET", `/requests/${rE}/questions`)).status === 401, "401 without a token");
  expect((await call("GET", `/requests/${rE}/questions`, { token: B.token })).status === 404, "another user");
  expect((await call("GET", "/requests/not-a-uuid/questions", { token: A.token })).status === 404, "malformed id");
  const e = await call("GET", `/requests/${rE}/questions`, { token: A.token });
  expect(e.status === 200 && e.json.category === "electrical_residential_installation" && e.json.questions[0].key === "burning_or_sparks", `electrical: ${e.text}`);
  expect(e.json.missingRequired.length === 4 && e.json.emergency.triggered === false, "nothing answered, no emergency");
  const g = await call("GET", `/requests/${rG}/questions`, { token: A.token });
  expect(g.json.category === null && g.json.questions.length === 3 && g.json.missingRequired.join() === "urgency,site_type", `plain: ${g.text}`);
});

test("answers: validation and permissions", async () => {
  expect((await call("PUT", `/requests/${rE}/answers`, { body: { answers: { urgency: "today" } }, token: A.token })).status === 400, "key required");
  expect((await put(rE, A.token, {}, "an-empty")).status === 400, "empty answers");
  const unknown = await put(rE, A.token, { colour: "red" }, "an-unknown");
  expect(unknown.status === 400 && code(unknown) === "invalid_answers", `unknown key ${unknown.status}`);
  expect(code(await put(rE, A.token, { burning_or_sparks: "no" }, "an-type")) === "invalid_answers", "wrong type");
  expect(code(await put(rE, A.token, { urgency: "yesterday" }, "an-option")) === "invalid_answers", "option not in the list");
  expect((await call("PUT", `/requests/${rE}/answers`, { body: { answers: { urgency: "today" }, extra: 1 }, token: A.token, key: k("an-extra") })).status === 400, "extra top-level field");
  expect((await put(rE, B.token, { urgency: "today" }, "an-other")).status === 404, "another user");
});

test("answers: partial saves, replay, update, trimming", async () => {
  const first = await put(rE, A.token, { urgency: "today", fault_scope: "one_room", burning_or_sparks: false }, "an-1");
  expect(first.status === 200 && Object.keys(first.json.answers).length === 3 && first.json.missingRequired.join() === "site_type" && first.json.emergency.triggered === false, `first ${first.status} ${first.text}`);
  saves++;
  const replay = await put(rE, A.token, { urgency: "today", fault_scope: "one_room", burning_or_sparks: false }, "an-1");
  expect(replay.status === 200 && replay.replayed, "replay");
  const second = await put(rE, A.token, { urgency: "asap", site_type: "house", details: "  Breaker box is in the garage  " }, "an-2");
  expect(second.status === 200 && second.json.answers.urgency === "asap" && second.json.answers.details === "Breaker box is in the garage" && second.json.missingRequired.length === 0, `second ${second.text}`);
  saves++;
  const g = await put(rG, A.token, { urgency: "flexible" }, "an-g");
  expect(g.status === 200, `plain answers ${g.status}`);
  saves++;
  expect(code(await put(rG, A.token, { burning_or_sparks: true }, "an-g-bad")) === "invalid_answers", "a safety question of another category is not valid here");
});

test("safety: a dangerous answer flags an emergency and points to emergency services", async () => {
  const r = await put(rE, A.token, { burning_or_sparks: true }, "an-danger");
  saves++;
  expect(r.status === 200 && r.json.emergency.triggered && r.json.emergency.keys.join() === "burning_or_sparks" && /emergency services/i.test(r.json.emergency.message), `danger ${r.text}`);
  const q = await call("GET", `/requests/${rE}/questions`, { token: A.token });
  expect(q.json.emergency.triggered === true && q.json.questions.find((x: any) => x.key === "burning_or_sparks").value === true, "questions endpoint shows it too");
});

test("upload-url: validation and permissions", async () => {
  expect((await call("POST", `/requests/${rE}/attachments/upload-url`, { body: { kind: "photo", mimeType: "image/jpeg", sizeBytes: 1000 }, token: A.token })).status === 400, "key required");
  expect(code(await upload(rE, A.token, { kind: "video", mimeType: "image/jpeg", sizeBytes: 1000 }, "u-mismatch")) === "unsupported_media_type", "mime must match the kind");
  expect(code(await upload(rE, A.token, { kind: "photo", mimeType: "application/x-msdownload", sizeBytes: 1000 }, "u-exe")) === "unsupported_media_type", "executables are refused");
  const big = await upload(rE, A.token, { kind: "photo", mimeType: "image/jpeg", sizeBytes: 11 * MB }, "u-big");
  expect(big.status === 400 && code(big) === "too_large", `too large ${big.status}`);
  expect((await upload(rE, A.token, { kind: "photo", mimeType: "image/jpeg", sizeBytes: 0 }, "u-zero")).status === 400, "zero bytes");
  expect((await upload(rE, A.token, { kind: "photo", mimeType: "image/jpeg", sizeBytes: 5, colour: 1 }, "u-extra")).status === 400, "unknown field");
  expect((await upload(rE, B.token, { kind: "photo", mimeType: "image/jpeg", sizeBytes: 1000 }, "u-other")).status === 404, "another user");
});

test("attachment lifecycle: upload-url, confirm needs a real upload, replay, ready", async () => {
  const body = { kind: "photo", mimeType: "image/jpeg", sizeBytes: 2_000_000, filename: "breaker.jpg" };
  const r = await upload(rE, A.token, body, "u-1");
  expect(r.status === 201 && r.json.attachment.status === "pending" && r.json.upload.method === "PUT" && r.json.upload.url.startsWith(`memory://upload/requests/${rE}/`), `upload-url ${r.status} ${r.text}`);
  expect(!("storageKey" in r.json.attachment), "the storage key must not be exposed");
  att1 = r.json.attachment.id;
  expect((await upload(rE, A.token, body, "u-1")).replayed, "replay returns the same upload");
  const [row] = await db.select({ key: requestAttachments.storageKey }).from(requestAttachments).where(eq(requestAttachments.id, att1));
  att1Key = row.key;

  const early = await call("POST", `/requests/${rE}/attachments/${att1}/confirm`, { body: {}, token: A.token, key: k("c-early") });
  expect(early.status === 409 && code(early) === "upload_missing", `confirm before upload ${early.status}`);
  memoryStorage.simulateUpload(att1Key, 1_900_000);
  const sha = "a".repeat(64);
  expect((await call("POST", `/requests/${rE}/attachments/${att1}/confirm`, { body: { sha256: sha }, token: B.token, key: k("c-other") })).status === 404, "another user");
  expect((await call("POST", `/requests/${rE}/attachments/${att1}/confirm`, { body: { sha256: "xyz" }, token: A.token, key: k("c-badhash") })).status === 400, "bad hash");
  const ok = await call("POST", `/requests/${rE}/attachments/${att1}/confirm`, { body: { sha256: sha }, token: A.token, key: k("c-ok") });
  expect(ok.status === 200 && ok.json.attachment.status === "ready" && ok.json.attachment.sizeBytes === 1_900_000 && ok.json.attachment.sha256 === sha && ok.json.attachment.confirmedAt, `confirm ${ok.status} ${ok.text}`);
  const again = await call("POST", `/requests/${rE}/attachments/${att1}/confirm`, { body: {}, token: A.token, key: k("c-again") });
  expect(again.status === 200 && again.json.attachment.status === "ready", "confirming twice is harmless");
});

test("a file bigger than it claimed is refused at confirm and can be deleted", async () => {
  const r = await upload(rE, A.token, { kind: "photo", mimeType: "image/png", sizeBytes: 1000 }, "u-2");
  expect(r.status === 201, `upload-url ${r.status}`);
  const id = r.json.attachment.id;
  const [row] = await db.select({ key: requestAttachments.storageKey }).from(requestAttachments).where(eq(requestAttachments.id, id));
  memoryStorage.simulateUpload(row.key, 11 * MB);
  const c = await call("POST", `/requests/${rE}/attachments/${id}/confirm`, { body: {}, token: A.token, key: k("c-big") });
  expect(c.status === 409 && code(c) === "upload_too_large", `oversize ${c.status} ${c.text}`);
  expect((await call("DELETE", `/requests/${rE}/attachments/${id}`, { body: {}, token: B.token, key: k("d-other") })).status === 404, "another user cannot delete");
  const d = await call("DELETE", `/requests/${rE}/attachments/${id}`, { body: {}, token: A.token, key: k("d-1") });
  expect(d.status === 200 && d.json.deleted === true && !memoryStorage.has(row.key), `delete ${d.status} ${d.text}`);
  expect((await call("DELETE", `/requests/${rE}/attachments/${id}`, { body: {}, token: A.token, key: k("d-2") })).status === 404, "already gone");
});

test("limit: a request holds a bounded number of files", async () => {
  expect((await upload(rE, A.token, { kind: "video", mimeType: "video/mp4", sizeBytes: 50 * MB }, "u-video")).status === 201, "video accepted");
  expect((await upload(rE, A.token, { kind: "document", mimeType: "application/pdf", sizeBytes: 100_000 }, "u-doc")).status === 201, "document accepted");
  const over = await upload(rE, A.token, { kind: "photo", mimeType: "image/jpeg", sizeBytes: 1000 }, "u-over");
  expect(over.status === 409 && code(over) === "attachment_limit", `limit ${over.status} ${over.text}`);
  expect((await upload(rE, A.token, { kind: "video", mimeType: "video/mp4", sizeBytes: 101 * MB }, "u-bigvideo")).status === 400, "video over 100 MB");
});

test("list: owner only; signed link only for confirmed files", async () => {
  const l = await call("GET", `/requests/${rE}/attachments`, { token: A.token });
  expect(l.status === 200 && l.json.attachments.length === 3, `list ${l.status} ${l.text}`);
  const ready = l.json.attachments.filter((a: any) => a.status === "ready");
  const pending = l.json.attachments.filter((a: any) => a.status === "pending");
  expect(ready.length === 1 && ready[0].id === att1 && ready[0].downloadUrl.startsWith("memory://download/") && pending.every((a: any) => a.downloadUrl === null), "download link only when ready");
  expect(l.json.attachments.every((a: any) => !("storageKey" in a)), "no storage keys in the list");
  expect((await call("GET", `/requests/${rE}/attachments`, { token: B.token })).status === 404, "another user");
});

test("a converted request is closed to changes but still readable", async () => {
  const cv = await call("POST", `/requests/${rG}/convert`, { body: { currency: "NGN" }, token: A.token, key: k("cv-g") });
  expect(cv.status === 201, `convert ${cv.status} ${cv.text}`);
  expect(code(await put(rG, A.token, { urgency: "today" }, "an-closed")) === "request_closed", "answers refused");
  expect(code(await upload(rG, A.token, { kind: "photo", mimeType: "image/jpeg", sizeBytes: 1000 }, "u-closed")) === "request_closed", "uploads refused");
  expect((await call("GET", `/requests/${rG}/questions`, { token: A.token })).status === 200, "still readable");
});

test("activity: each change is recorded once; replays and refusals add nothing", async () => {
  const ev = await db.select({ t: activityEvents.eventType }).from(activityEvents).where(eq(activityEvents.actorUserId, A.id));
  const n = (t: string) => ev.filter((e) => e.t === t).length;
  expect(n("request.answers_saved") === saves, `answers_saved x${n("request.answers_saved")} (want ${saves})`);
  expect(n("request.attachment_added") === 1, `attachment_added x${n("request.attachment_added")}`);
  expect(n("request.attachment_removed") === 1, `attachment_removed x${n("request.attachment_removed")}`);
  expect((await db.select({ id: activityEvents.id }).from(activityEvents).where(eq(activityEvents.actorUserId, B.id))).length === 0, "refused requests leave no activity");
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
