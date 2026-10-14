import "dotenv/config";
import { queryClient } from "../db/client.js";
import { call, cleanupTestUsers, createProject, expect, registerProvider, registerUser } from "./test-helpers.js";

// Awards and payments views behind the milestone screen. Sandbox gateway. Needs `npm run db:seed`.
process.env.PAYMENTS_PROVIDER = "sandbox";

const stamp = Date.now().toString(36);
const LIKE = "mviewtest-%@test.invalid";
const k = (n: string) => `${n}-${stamp}`;

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

let A = { token: "", id: "" };
let S = { token: "", id: "" };
let P = { token: "", id: "", providerId: "" };
let projectId = "";
let assignmentId = "";
let milestoneId = "";

test("setup: owner, stranger, an awarded and accepted provider", async () => {
  A = await registerUser(`mviewtest-${stamp}-a@test.invalid`);
  S = await registerUser(`mviewtest-${stamp}-s@test.invalid`);
  P = await registerProvider(`mviewtest-${stamp}-p@test.invalid`, `mv-${stamp}`);
  const p = await createProject(A.token, `mv-${stamp}`, "Fix the leaking tap");
  projectId = p.projectId;
  expect((await call("POST", `/tasks/${p.taskId}/transition`, { body: { to: "ready" }, token: A.token, key: k("r") })).status === 200, "task ready");
  const inv = await call("POST", `/tasks/${p.taskId}/invitations`, { body: { providerProfileId: P.providerId }, token: A.token, key: k("i") });
  expect(inv.status === 201, `invite ${inv.status} ${inv.text}`);
  const q = await call("POST", `/tasks/${p.taskId}/quotes`, {
    body: { currency: "NGN", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), lines: [{ kind: "labour", description: "Work", quantity: 1, unitPriceMinor: 900000 }] },
    token: P.token, key: k("q"),
  });
  expect(q.status === 201, `quote ${q.status} ${q.text}`);
  expect((await call("POST", `/quotes/${q.json.quote.id}/submit`, { body: {}, token: P.token, key: k("s") })).status === 200, "submit quote");
  const acc = await call("POST", `/quotes/${q.json.quote.id}/accept`, { body: {}, token: A.token, key: k("a") });
  expect(acc.status === 200, `accept ${acc.status} ${acc.text}`);
  assignmentId = acc.json.assignment.id;
  expect((await call("POST", `/assignments/${assignmentId}/accept`, { body: {}, token: P.token, key: k("aa") })).status === 200, "provider accepts");
});

test("awards: money roles only, shows the agreed quote and what is left to split", async () => {
  expect((await call("GET", `/projects/${projectId}/awards`)).status === 401, "401");
  expect((await call("GET", `/projects/${projectId}/awards`, { token: S.token })).status === 404, "stranger 404");
  expect((await call("GET", `/projects/${projectId}/awards`, { token: P.token })).status === 404, "provider-only 404");
  const r = await call("GET", `/projects/${projectId}/awards`, { token: A.token });
  expect(r.status === 200 && r.json.awards.length === 1, `awards ${r.text}`);
  const a = r.json.awards[0];
  expect(a.assignmentId === assignmentId && a.agreedMinor === 900000 && a.currency === "NGN" && a.plannedMinor === 0 && a.remainingMinor === 900000, `award ${JSON.stringify(a)}`);
  expect(typeof a.providerName === "string" && a.providerName.length > 0 && !("userId" in a), "provider name only, no private ids");

  const m = await call("POST", `/projects/${projectId}/milestones`, { body: { title: "Stage 1", amountMinor: 300000, currency: "NGN", assignmentId }, token: A.token, key: k("m1") });
  expect(m.status === 201, `milestone ${m.status} ${m.text}`);
  milestoneId = m.json.milestone.id;
  const after = (await call("GET", `/projects/${projectId}/awards`, { token: A.token })).json.awards[0];
  expect(after.plannedMinor === 300000 && after.remainingMinor === 600000, `after ${JSON.stringify(after)}`);
});

test("payments: money roles only, no gateway reference, shows the pending payment", async () => {
  expect((await call("GET", `/projects/${projectId}/payments`)).status === 401, "401");
  expect((await call("GET", `/projects/${projectId}/payments`, { token: S.token })).status === 404, "stranger 404");
  expect((await call("GET", `/projects/${projectId}/payments`, { token: P.token })).status === 404, "provider-only 404");
  const empty = await call("GET", `/projects/${projectId}/payments`, { token: A.token });
  expect(empty.status === 200 && empty.json.payments.length === 0, `empty ${empty.text}`);

  const pay = await call("POST", `/milestones/${milestoneId}/payments`, { body: {}, token: A.token, key: k("pay") });
  expect(pay.status === 201, `pay ${pay.status} ${pay.text}`);
  const list = await call("GET", `/projects/${projectId}/payments`, { token: A.token });
  expect(list.json.payments.length === 1, `one payment ${list.text}`);
  const row = list.json.payments[0];
  expect(row.milestoneId === milestoneId && row.state === "pending" && row.amountMinor === 300000 && row.currency === "NGN", `row ${JSON.stringify(row)}`);
  expect(!("providerReference" in row) && !("payerUserId" in row) && !("idempotencyKey" in row), "gateway and private fields are not exposed");
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
