import "dotenv/config";
import { queryClient } from "../db/client.js";
import { call, cleanupTestUsers, createProject, expect, registerUser } from "./test-helpers.js";

// Reference data, "my projects" and the provider directory. Needs `npm run db:seed`.
const stamp = Date.now().toString(36);
const LIKE = "disctest-%@test.invalid";
const NAME = `Disctest Plumber ${stamp}`;

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

let A = { token: "", id: "" };
let S = { token: "", id: "" };
let P = { token: "", id: "", providerId: "" };
let projectId = "";

test("setup: owner, stranger, a provider with a known name", async () => {
  A = await registerUser(`disctest-${stamp}-a@test.invalid`);
  S = await registerUser(`disctest-${stamp}-s@test.invalid`);
  const u = await registerUser(`disctest-${stamp}-p@test.invalid`);
  const pr = await call("POST", "/providers/me", { body: { displayName: NAME, headline: "Pipes and taps" }, token: u.token, key: `pv-${stamp}` });
  expect(pr.status === 201, `profile ${pr.status} ${pr.text}`);
  P = { ...u, providerId: pr.json.provider.id };
});

test("reference: public, lists active markets with currencies", async () => {
  const r = await call("GET", "/reference");
  expect(r.status === 200 && Array.isArray(r.json.markets), `got ${r.status} ${r.text}`);
  const ng = r.json.markets.find((m: any) => m.code === "NG");
  expect(ng && ng.currencies.includes("NGN") && ng.defaultCurrency === "NGN", `NG market ${JSON.stringify(ng)}`);
  expect(r.json.markets.every((m: any) => typeof m.id === "string" && Array.isArray(m.currencies)), "shape");
});

test("projects: 401 without token; empty for a new user", async () => {
  expect((await call("GET", "/projects")).status === 401, "401");
  const r = await call("GET", "/projects", { token: A.token });
  expect(r.status === 200 && r.json.projects.length === 0, `empty ${r.text}`);
});

test("projects: lists mine with roles, nobody else's", async () => {
  projectId = (await createProject(A.token, `dp-${stamp}`, "Disctest project")).projectId;
  const mine = await call("GET", "/projects", { token: A.token });
  const row = mine.json.projects.find((p: any) => p.id === projectId);
  expect(mine.status === 200 && row, `listed ${mine.text}`);
  expect(row.title && row.status && row.currency === "NGN" && row.roles.includes("project_owner"), `row ${JSON.stringify(row)}`);
  expect(row.taskStatuses && row.taskStatuses.draft === 1, `task counts ${JSON.stringify(row.taskStatuses)}`);
  expect(new Set(mine.json.projects.map((p: any) => p.id)).size === mine.json.projects.length, "one row per project");
  const theirs = await call("GET", "/projects", { token: S.token });
  expect(theirs.json.projects.length === 0, "a stranger sees nothing");
});

test("providers: auth required, search by name, public fields only, excludes self", async () => {
  expect((await call("GET", "/providers")).status === 401, "401");
  const hit = await call("GET", `/providers?q=${encodeURIComponent(NAME.toLowerCase())}`, { token: A.token });
  expect(hit.status === 200 && hit.json.providers.some((p: any) => p.id === P.providerId), `search ${hit.text}`);
  const row = hit.json.providers.find((p: any) => p.id === P.providerId);
  expect(!("userId" in row) && !("bio" in row), `private fields leaked ${JSON.stringify(row)}`);
  const miss = await call("GET", `/providers?q=${encodeURIComponent(`nobody-${stamp}-zzz`)}`, { token: A.token });
  expect(miss.status === 200 && miss.json.providers.length === 0, "no match is an empty list");
  const wild = await call("GET", "/providers?q=%25", { token: A.token });
  expect(wild.status === 200 && !wild.json.providers.some((p: any) => p.id === P.providerId), "a literal % is not a wildcard");
  const self = await call("GET", `/providers?q=${encodeURIComponent(NAME)}`, { token: P.token });
  expect(!self.json.providers.some((p: any) => p.id === P.providerId), "a provider does not see themselves");
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
