import "dotenv/config";
import app from "../index.js";

// Checks the Vercel entry (src/index.ts): the default export serves the whole API, and error / 404 handling still
// produces our JSON bodies through the wrapper. No database rows are read or written.
// Runs with the sandbox payment provider (NODE_ENV is not production here).
process.env.PAYMENTS_PROVIDER = "sandbox";

const tests: Array<[string, () => Promise<void>]> = [];
const test = (n: string, f: () => Promise<void>) => tests.push([n, f]);
const expect = (c: unknown, m: string) => { if (!c) throw new Error(m); };

test("default export is a Hono app with fetch()", async () => {
  expect(typeof app.fetch === "function" && typeof app.request === "function", "no fetch/request");
});

test("GET /health through the wrapper", async () => {
  const r = await app.request("/health");
  const j: any = await r.json();
  expect(r.status === 200 && j.ok === true, `got ${r.status} ${JSON.stringify(j)}`);
});

test("unknown path gives our JSON 404", async () => {
  const r = await app.request("/definitely/not/here");
  const j: any = await r.json();
  expect(r.status === 404 && j.error?.code === "not_found", `got ${r.status} ${JSON.stringify(j)}`);
});

test("auth middleware still applies: GET /me without a token is 401 JSON", async () => {
  const r = await app.request("/me");
  const j: any = await r.json();
  expect(r.status === 401 && j.error?.code === "unauthorized", `got ${r.status} ${JSON.stringify(j)}`);
});

test("error handler survives mounting: unsigned webhook is 401 invalid_signature (not a bare 500)", async () => {
  const r = await app.request("/webhooks/sandbox", { method: "POST", body: JSON.stringify({ event: "charge.success" }) });
  const j: any = await r.json();
  expect(r.status === 401 && j.error?.code === "invalid_signature", `got ${r.status} ${JSON.stringify(j)}`);
});

async function main() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); }
    catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
