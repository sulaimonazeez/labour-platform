import "dotenv/config";
import { queryClient } from "../db/client";
import { call, cleanupTestUsers, createProject, expect, registerProvider, registerUser } from "./test-helpers";

// Provider directory by trade, provider services, invitations list and per-provider message threads.
// Needs `npm run db:seed` (the electrical category) and the migrations applied.
const stamp = Date.now().toString(36);
const LIKE = "thrtest-%@test.invalid";
const ELEC = "electrical_residential_installation";
const k = (s: string) => `thr-${stamp}-${s}`;

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

let A = { token: "", id: "" };
let S = { token: "", id: "" };
let P1 = { token: "", id: "", providerId: "" };
let P2 = { token: "", id: "", providerId: "" };
let taskId = "";

test("setup: owner, stranger, two providers, a ready task", async () => {
  A = await registerUser(`thrtest-${stamp}-a@test.invalid`);
  S = await registerUser(`thrtest-${stamp}-s@test.invalid`);
  P1 = await registerProvider(`thrtest-${stamp}-p1@test.invalid`, `${stamp}-p1`);
  P2 = await registerProvider(`thrtest-${stamp}-p2@test.invalid`, `${stamp}-p2`);
  taskId = (await createProject(A.token, `${stamp}-proj`, "Rewire my kitchen")).taskId;
  const r = await call("POST", `/tasks/${taskId}/transition`, { body: { to: "ready" }, token: A.token, key: k("ready") });
  expect(r.status === 200, `ready ${r.status} ${r.text}`);
});

test("services: set, read back, unknown rejected, replaced not appended", async () => {
  const bad = await call("PUT", "/providers/me/services", { body: { categories: ["no_such_trade"] }, token: P1.token, key: k("svc-bad") });
  expect(bad.status === 400 && bad.json.error.code === "unknown_category", `unknown ${bad.status} ${bad.text}`);
  const ok = await call("PUT", "/providers/me/services", { body: { categories: [ELEC] }, token: P1.token, key: k("svc-ok") });
  expect(ok.status === 200, `set ${ok.status} ${ok.text}`);
  const got = await call("GET", "/providers/me/services", { token: P1.token });
  expect(got.status === 200 && got.json.categories.length === 1 && got.json.categories[0] === ELEC, `read ${got.text}`);
  expect((await call("PUT", "/providers/me/services", { body: { categories: [ELEC] }, token: S.token, key: k("svc-noprof") })).status === 404, "no profile");
});

test("directory: ?category= returns only providers who list that trade", async () => {
  const r = await call("GET", `/providers?category=${ELEC}`, { token: A.token });
  expect(r.status === 200, `got ${r.status} ${r.text}`);
  expect(r.json.providers.some((p: any) => p.id === P1.providerId), "P1 listed under electrical");
  expect(!r.json.providers.some((p: any) => p.id === P2.providerId), "P2 never chose a trade, so not listed");
  const row = r.json.providers.find((p: any) => p.id === P1.providerId);
  expect(row.categories.includes(ELEC), `categories on the row ${JSON.stringify(row)}`);
});

test("invitations list + thread: manager only; one private thread per provider", async () => {
  for (const [pid, key] of [[P1.providerId, "inv1"], [P2.providerId, "inv2"]] as const) {
    const i = await call("POST", `/tasks/${taskId}/invitations`, { body: { providerProfileId: pid }, token: A.token, key: k(key) });
    expect(i.status === 201, `invite ${i.status} ${i.text}`);
  }
  const list = await call("GET", `/tasks/${taskId}/invitations`, { token: A.token });
  expect(list.status === 200 && list.json.invitations.length === 2, `list ${list.text}`);
  expect((await call("GET", `/tasks/${taskId}/invitations`, { token: P1.token })).status === 404, "a provider cannot list invitations");
  expect((await call("GET", `/tasks/${taskId}/invitations`, { token: S.token })).status === 404, "a stranger gets 404");

  const m1 = await call("POST", `/tasks/${taskId}/messages`, { body: { text: "Can you come Tuesday?", provider: P1.providerId }, token: A.token, key: k("m1") });
  expect(m1.status === 201, `manager send ${m1.status} ${m1.text}`);
  const noProv = await call("POST", `/tasks/${taskId}/messages`, { body: { text: "hi" }, token: A.token, key: k("m-noprov") });
  expect(noProv.status === 400, "manager must say which provider");
  const reply = await call("POST", `/tasks/${taskId}/messages`, { body: { text: "Tuesday works." }, token: P1.token, key: k("m2") });
  expect(reply.status === 201, `provider reply ${reply.status} ${reply.text}`);

  const t1 = await call("GET", `/tasks/${taskId}/messages?provider=${P1.providerId}`, { token: A.token });
  expect(t1.status === 200 && t1.json.messages.length === 2, `manager sees both ${t1.text}`);
  expect(t1.json.messages[0].mine === true && t1.json.messages[1].mine === false, "mine flag");
  const own = await call("GET", `/tasks/${taskId}/messages`, { token: P1.token });
  expect(own.json.messages.length === 2, "provider sees their own thread");
  const other = await call("GET", `/tasks/${taskId}/messages`, { token: P2.token });
  expect(other.status === 200 && other.json.messages.length === 0, "the other invited provider sees nothing of it");
  expect(!("senderUserId" in t1.json.messages[0]) || t1.json.messages[0].senderUserId === undefined, "no user ids leaked");
});

test("thread: strangers and uninvited providers are shut out; replay is safe", async () => {
  expect((await call("GET", `/tasks/${taskId}/messages`, { token: S.token })).status === 404, "stranger GET");
  expect((await call("POST", `/tasks/${taskId}/messages`, { body: { text: "x" }, token: S.token, key: k("s-send") })).status === 404, "stranger POST");
  const P3 = await registerProvider(`thrtest-${stamp}-p3@test.invalid`, `${stamp}-p3`);
  expect((await call("GET", `/tasks/${taskId}/messages`, { token: P3.token })).status === 404, "uninvited provider");
  expect((await call("POST", `/tasks/${taskId}/messages`, { body: { text: "" }, token: P1.token, key: k("empty") })).status === 400, "empty text");
  const a = await call("POST", `/tasks/${taskId}/messages`, { body: { text: "same key" }, token: P1.token, key: k("replay") });
  const b = await call("POST", `/tasks/${taskId}/messages`, { body: { text: "same key" }, token: P1.token, key: k("replay") });
  expect(a.status === 201 && b.status === 201 && a.json.message.id === b.json.message.id, "same key, same message");
  const t = await call("GET", `/tasks/${taskId}/messages`, { token: P1.token });
  expect(t.json.messages.filter((m: any) => m.text === "same key").length === 1, "one row, not two");
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
