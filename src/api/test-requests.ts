import "dotenv/config";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { app } from "./app";
import { db, queryClient } from "../db/client";
import { activityEvents, idempotencyKeys, requests } from "../db/schema";

// In-process tests against the real DB (needs `npm run db:seed`: market NG + category plumbing_residential).
// Creates two throwaway users (reqtest-*@test.invalid). Cleanup runs before and after via DIRECT_URL:
// activity_events is append-only, so cleanup disables that one trigger INSIDE a transaction, deletes only rows
// belonging to the test users, and re-enables it before commit. A crash mid-way rolls the whole thing back.
// Run: npm run test:requests

const stamp = Date.now().toString(36);
const emailA = `reqtest-${stamp}-a@test.invalid`;
const emailB = `reqtest-${stamp}-b@test.invalid`;
const password = "correct horse battery";

async function call(method: string, path: string, opts: { body?: unknown; token?: string; key?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.key) headers["idempotency-key"] = opts.key;
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text, replayed: res.headers.get("idempotent-replayed") === "true" };
}

function expect(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

async function cleanup() {
  const url = process.env.DIRECT_URL;
  if (!url) { console.log("WARN  DIRECT_URL not set: skipping cleanup"); return; }
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await admin.begin(async (t) => {
      const ids = (await t`select id from users where email like 'reqtest-%@test.invalid'`).map((r) => r.id as string);
      if (ids.length === 0) return;
      await t`alter table activity_events disable trigger trg_activity_events_append_only`;
      await t`delete from activity_events where actor_user_id in ${t(ids)}`;
      await t`alter table activity_events enable trigger trg_activity_events_append_only`;
      await t`delete from idempotency_keys where right(scope, 36) in ${t(ids)}`;
      await t`delete from projects where owner_user_id in ${t(ids)}`;
      await t`delete from requests where requester_user_id in ${t(ids)}`;
      await t`delete from users where id in ${t(ids)}`;
    });
  } catch (e) {
    console.log(`WARN  cleanup failed (test rows may remain): ${(e as Error).message}`);
  } finally {
    await admin.end({ timeout: 2 });
  }
}

let tokenA = "";
let tokenB = "";
let userA = "";
let reqId = "";
let projectId = "";
const k = (name: string) => `${name}-${stamp}`; // >= 8 chars, allowed charset

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("setup: register two users in market NG", async () => {
  const base = { password, displayName: "Req Test", preferredLanguage: "en", timezone: "Africa/Lagos", marketCode: "NG" };
  const a = await call("POST", "/auth/register", { body: { ...base, email: emailA } });
  const b = await call("POST", "/auth/register", { body: { ...base, email: emailB } });
  expect(a.status === 201 && b.status === 201, `register got ${a.status} / ${b.status}: ${a.text} ${b.text}`);
  tokenA = a.json.token;
  tokenB = b.json.token;
  const me = await call("GET", "/me", { token: tokenA });
  userA = me.json.user.id;
});

test("requests: 401 without a token", async () => {
  const r = await call("POST", "/requests", { body: { rawText: "x" }, key: k("noauth-key") });
  expect(r.status === 401, `got ${r.status}`);
});

test("requests: Idempotency-Key is required (400) and must be well-formed", async () => {
  const a = await call("POST", "/requests", { body: { rawText: "Fix my tap" }, token: tokenA });
  expect(a.status === 400 && a.json?.error?.code === "idempotency_key_required", `got ${a.status} ${a.text}`);
  const b = await call("POST", "/requests", { body: { rawText: "Fix my tap" }, token: tokenA, key: "short" });
  expect(b.status === 400 && b.json?.error?.code === "invalid_idempotency_key", `got ${b.status} ${b.text}`);
});

test("requests: validation (nothing to describe, unknown field, bad market/category/language)", async () => {
  const none = await call("POST", "/requests", { body: {}, token: tokenA, key: k("v-none-key") });
  expect(none.status === 400 && none.json?.error?.code === "validation_error", `empty: ${none.status} ${none.text}`);
  const extra = await call("POST", "/requests", { body: { rawText: "x", requesterUserId: "00000000-0000-4000-8000-000000000000" }, token: tokenA, key: k("v-extra-key") });
  expect(extra.status === 400 && extra.json?.error?.code === "validation_error", `unknown field accepted: ${extra.status} ${extra.text}`);
  const mk = await call("POST", "/requests", { body: { rawText: "x", marketCode: "ZZ" }, token: tokenA, key: k("v-mkt-key1") });
  expect(mk.status === 400 && mk.json?.error?.code === "unknown_market", `market: ${mk.status} ${mk.text}`);
  const cat = await call("POST", "/requests", { body: { rawText: "x", categoryKey: "no_such_category" }, token: tokenA, key: k("v-cat-key1") });
  expect(cat.status === 400 && cat.json?.error?.code === "unknown_category", `category: ${cat.status} ${cat.text}`);
  const lang = await call("POST", "/requests", { body: { rawText: "x", originalLanguage: "xx" }, token: tokenA, key: k("v-lang-key") });
  expect(lang.status === 400 && lang.json?.error?.code === "unknown_language", `language: ${lang.status} ${lang.text}`);
});

test("requests: failed attempts do not burn the key (same key works after a fix)", async () => {
  const bad = await call("POST", "/requests", { body: { rawText: "x", categoryKey: "no_such_category" }, token: tokenA, key: k("reuse-after-fail") });
  expect(bad.status === 400, `bad got ${bad.status}`);
  const rows = await db.select({ k: idempotencyKeys.key }).from(idempotencyKeys).where(eq(idempotencyKeys.key, k("reuse-after-fail")));
  expect(rows.length === 0, "idempotency key row survived a failed request");
});

test("requests: create returns 201, uses the user's market and language", async () => {
  const r = await call("POST", "/requests", {
    body: { rawText: "My leaking tap needs fixing", categoryKey: "plumbing_residential" },
    token: tokenA, key: k("create-main"),
  });
  expect(r.status === 201, `got ${r.status} ${r.text}`);
  const q = r.json.request;
  expect(q.status === "open" && q.path === "quick_service" && q.originalLanguage === "en", `unexpected: ${r.text}`);
  expect(q.requesterUserId === userA && q.categoryId && q.marketId, "owner/category/market not set");
  expect(q.rawText === "My leaking tap needs fixing", "raw text was altered");
  reqId = q.id;
});

test("requests: replay with the same key returns the same response, creates nothing new", async () => {
  const r = await call("POST", "/requests", {
    body: { categoryKey: "plumbing_residential", rawText: "My leaking tap needs fixing" }, // key order differs on purpose
    token: tokenA, key: k("create-main"),
  });
  expect(r.status === 201 && r.replayed && r.json.request.id === reqId, `got ${r.status} replayed=${r.replayed} ${r.text}`);
  const rows = await db.select({ id: requests.id }).from(requests).where(eq(requests.requesterUserId, userA));
  expect(rows.length === 1, `expected 1 request row, found ${rows.length}`);
  const ev = await db.select({ id: activityEvents.id }).from(activityEvents)
    .where(and(eq(activityEvents.subjectId, reqId), eq(activityEvents.eventType, "request.created")));
  expect(ev.length === 1, `expected exactly 1 request.created event, found ${ev.length}`);
});

test("requests: same key with a different body is 422", async () => {
  const r = await call("POST", "/requests", { body: { rawText: "Something else entirely" }, token: tokenA, key: k("create-main") });
  expect(r.status === 422 && r.json?.error?.code === "idempotency_key_reuse", `got ${r.status} ${r.text}`);
});

test("requests: the same key from another user is independent", async () => {
  const r = await call("POST", "/requests", { body: { rawText: "My leaking tap needs fixing", categoryKey: "plumbing_residential" }, token: tokenB, key: k("create-main") });
  expect(r.status === 201 && !r.replayed && r.json.request.id !== reqId, `got ${r.status} replayed=${r.replayed} ${r.text}`);
});

test("requests: 5 parallel retries with one key create exactly one request", async () => {
  const body = { rawText: "Parallel retry check" };
  const rs = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/requests", { body, token: tokenA, key: k("parallel-key") })));
  expect(rs.every((r) => r.status === 201), `statuses: ${rs.map((r) => r.status).join(",")}`);
  expect(new Set(rs.map((r) => r.json.request.id)).size === 1, "different request ids returned");
  const rows = await db.select({ id: requests.id }).from(requests).where(eq(requests.rawText, "Parallel retry check"));
  expect(rows.length === 1, `expected 1 row, found ${rows.length}`);
});

test("requests: GET by id works for the owner, 404 for others and for malformed ids", async () => {
  const own = await call("GET", `/requests/${reqId}`, { token: tokenA });
  expect(own.status === 200 && own.json.request.id === reqId, `owner got ${own.status}`);
  const other = await call("GET", `/requests/${reqId}`, { token: tokenB });
  expect(other.status === 404, `other user got ${other.status}`);
  const bad = await call("GET", "/requests/not-a-uuid", { token: tokenA });
  expect(bad.status === 404, `malformed id got ${bad.status}`);
});

test("requests: list returns only my requests", async () => {
  const r = await call("GET", "/requests", { token: tokenB });
  expect(r.status === 200 && r.json.requests.every((x: any) => x.requesterUserId !== userA), "B sees A's requests");
});

test("convert: key required; currency required; currency must be enabled for the market", async () => {
  const nokey = await call("POST", `/requests/${reqId}/convert`, { body: { currency: "NGN" }, token: tokenA });
  expect(nokey.status === 400 && nokey.json?.error?.code === "idempotency_key_required", `nokey: ${nokey.status} ${nokey.text}`);
  const nocur = await call("POST", `/requests/${reqId}/convert`, { body: {}, token: tokenA, key: k("conv-nocur-k") });
  expect(nocur.status === 400 && nocur.json?.error?.code === "validation_error", `nocur: ${nocur.status} ${nocur.text}`);
  const eur = await call("POST", `/requests/${reqId}/convert`, { body: { currency: "EUR" }, token: tokenA, key: k("conv-eur-key") });
  expect(eur.status === 400 && eur.json?.error?.code === "currency_not_allowed", `eur: ${eur.status} ${eur.text}`);
});

test("convert: another user gets 404 and nothing changes", async () => {
  const r = await call("POST", `/requests/${reqId}/convert`, { body: { currency: "NGN" }, token: tokenB, key: k("conv-other-k") });
  expect(r.status === 404, `got ${r.status} ${r.text}`);
  const own = await call("GET", `/requests/${reqId}`, { token: tokenA });
  expect(own.json.request.status === "open", `status changed to ${own.json.request.status}`);
});

test("convert: success creates project, stage, task; request becomes converted", async () => {
  const r = await call("POST", `/requests/${reqId}/convert`, { body: { currency: "ngn" }, token: tokenA, key: k("conv-main-key") });
  expect(r.status === 201, `got ${r.status} ${r.text}`);
  expect(r.json.project.currency === "NGN" && r.json.project.status === "draft", `project: ${JSON.stringify(r.json.project)}`);
  expect(r.json.project.timezone === "Africa/Lagos" && r.json.project.title === "My leaking tap needs fixing", "defaults wrong");
  expect(r.json.stageId && r.json.taskId, "stage/task missing");
  projectId = r.json.project.id;
  const own = await call("GET", `/requests/${reqId}`, { token: tokenA });
  expect(own.json.request.status === "converted", `request status ${own.json.request.status}`);
});

test("convert: replay returns the same project; a different key is 409 already_converted", async () => {
  const same = await call("POST", `/requests/${reqId}/convert`, { body: { currency: "ngn" }, token: tokenA, key: k("conv-main-key") });
  expect(same.status === 201 && same.replayed && same.json.project.id === projectId, `replay: ${same.status} ${same.text}`);
  const again = await call("POST", `/requests/${reqId}/convert`, { body: { currency: "NGN" }, token: tokenA, key: k("conv-again-ke") });
  expect(again.status === 409 && again.json?.error?.code === "already_converted", `again: ${again.status} ${again.text}`);
});

test("convert: activity stream has request.converted and project.created, once each", async () => {
  const ev = await db.select({ t: activityEvents.eventType, p: activityEvents.projectId }).from(activityEvents)
    .where(eq(activityEvents.projectId, projectId));
  const types = ev.map((e) => e.t).sort().join(",");
  expect(types === "project.created,request.converted", `events: ${types}`);
});

test("projects: owner can read; non-member gets 404", async () => {
  const own = await call("GET", `/projects/${projectId}`, { token: tokenA });
  expect(own.status === 200, `owner got ${own.status} ${own.text}`);
  expect(own.json.roles.includes("project_owner") && own.json.stages.length === 1 && own.json.tasks.length === 1, `shape: ${own.text}`);
  expect(own.json.tasks[0].status === "draft", "first task should be draft");
  const other = await call("GET", `/projects/${projectId}`, { token: tokenB });
  expect(other.status === 404, `non-member got ${other.status}`);
  expect((await call("GET", `/projects/${projectId}`)).status === 401, "unauthenticated not 401");
});

async function main() {
  let failed = 0;
  await cleanup();
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
    await cleanup();
    await queryClient.end();
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
