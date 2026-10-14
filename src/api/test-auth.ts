import "dotenv/config";
import { eq, like } from "drizzle-orm";
import { app } from "./app.js";
import { db, queryClient } from "../db/client.js";
import { sessions, userCredentials, users } from "../db/schema/index.js";
import { hashToken } from "../auth/session.js";

// In-process tests against the real DB. Creates one throwaway user (authtest-*@test.invalid)
// and deletes it at the end (sessions and credentials cascade).
const email = `authtest-${Date.now().toString(36)}@test.invalid`;
const password = "correct horse battery";
const base = { email, password, displayName: "Auth Test", preferredLanguage: "en", timezone: "Africa/Lagos" };

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

function expect(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

let token1 = "";
let token2 = "";
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("register: short password rejected (400)", async () => {
  const r = await call("POST", "/auth/register", { ...base, password: "short123" });
  expect(r.status === 400 && r.json?.error?.code === "validation_error", `got ${r.status} ${r.text}`);
});

test("register: unknown language rejected (400)", async () => {
  const r = await call("POST", "/auth/register", { ...base, preferredLanguage: "xx" });
  expect(r.status === 400 && r.json?.error?.code === "unknown_language", `got ${r.status} ${r.text}`);
});

test("register: success returns token, never the password or hash", async () => {
  const r = await call("POST", "/auth/register", base);
  expect(r.status === 201, `got ${r.status} ${r.text}`);
  token1 = r.json.token;
  expect(typeof token1 === "string" && token1.length >= 40, "token missing");
  expect(!/password|argon2|hash/i.test(r.text), "response leaks credential material");
});

test("storage: password is argon2id; only the token HASH is stored", async () => {
  const [cred] = await db.select({ h: userCredentials.passwordHash }).from(userCredentials)
    .innerJoin(users, eq(users.id, userCredentials.userId)).where(eq(users.email, email));
  expect(cred?.h.startsWith("$argon2id$"), "password hash is not argon2id");
  const byHash = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.tokenHash, hashToken(token1)));
  const byRaw = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.tokenHash, token1));
  expect(byHash.length === 1 && byRaw.length === 0, "raw token found in DB or hash missing");
});

test("register: duplicate email (also different case) is 409", async () => {
  const a = await call("POST", "/auth/register", base);
  const b = await call("POST", "/auth/register", { ...base, email: email.toUpperCase() });
  expect(a.status === 409 && b.status === 409, `got ${a.status} / ${b.status}`);
});

test("login: wrong password and unknown email give the same 401", async () => {
  const a = await call("POST", "/auth/login", { email, password: "wrong password here" });
  const b = await call("POST", "/auth/login", { email: `nobody-${email}`, password });
  expect(a.status === 401 && b.status === 401, `got ${a.status} / ${b.status}`);
  expect(a.text === b.text, "responses differ (account enumeration)");
});

test("login: success issues a distinct session token", async () => {
  const r = await call("POST", "/auth/login", { email: email.toUpperCase(), password });
  expect(r.status === 200, `got ${r.status} ${r.text}`);
  token2 = r.json.token;
  expect(token2 && token2 !== token1, "token not distinct");
});

test("/me: works with a valid token", async () => {
  const r = await call("GET", "/me", undefined, token1);
  expect(r.status === 200 && r.json?.user?.email === email, `got ${r.status} ${r.text}`);
});

test("/me: 401 without token and with garbage token", async () => {
  const a = await call("GET", "/me");
  const b = await call("GET", "/me", undefined, "not-a-real-token");
  expect(a.status === 401 && b.status === 401, `got ${a.status} / ${b.status}`);
});

test("logout: revokes only that session", async () => {
  const out = await call("POST", "/auth/logout", undefined, token1);
  expect(out.status === 204, `logout got ${out.status}`);
  expect((await call("GET", "/me", undefined, token1)).status === 401, "revoked token still works");
  expect((await call("GET", "/me", undefined, token2)).status === 200, "other session was revoked too");
});

test("expired session is rejected", async () => {
  await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.tokenHash, hashToken(token2)));
  expect((await call("GET", "/me", undefined, token2)).status === 401, "expired token still works");
});

test("suspended user: login and existing sessions are rejected", async () => {
  const l = await call("POST", "/auth/login", { email, password });
  expect(l.status === 200, `login got ${l.status}`);
  const t = l.json.token;
  await db.update(users).set({ status: "suspended" }).where(eq(users.email, email));
  expect((await call("GET", "/me", undefined, t)).status === 401, "suspended user's session still works");
  expect((await call("POST", "/auth/login", { email, password })).status === 401, "suspended user can log in");
});

async function main() {
  let failed = 0;
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
    await db.delete(users).where(like(users.email, "authtest-%@test.invalid"));
    await queryClient.end();
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
