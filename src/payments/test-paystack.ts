import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPaystackProvider } from "./paystack.js";
import { ProviderError } from "./provider.js";

// Exercises the REAL Paystack adapter code against a local fake Paystack server (no network, no database, no keys).
// This proves our request shape, response mapping, error handling and signature check. It does NOT prove Paystack's
// real behaviour: that needs the live test-mode checklist in docs/NEXT_STEPS.md.

const SECRET = "sk_test_unit";

type Seen = { method: string; url: string; auth: string | undefined; body: any };
let seen: Seen[] = [];
let reply: (s: Seen) => { status: number; body: unknown } = () => ({ status: 500, body: {} });

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const s: Seen = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: text ? JSON.parse(text) : null };
  seen.push(s);
  const r = reply(s);
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(JSON.stringify(r.body));
});

const tests: Array<[string, () => Promise<void>]> = [];
const test = (n: string, f: () => Promise<void>) => tests.push([n, f]);
const expect = (c: unknown, m: string) => { if (!c) throw new Error(m); };

let provider: ReturnType<typeof createPaystackProvider>;
const ok = (data: unknown) => ({ status: 200, body: { status: true, message: "ok", data } });

async function rejects(fn: () => Promise<unknown>) {
  try { await fn(); } catch (e) { return e; }
  throw new Error("expected a rejection");
}

test("initialize: sends the documented request and maps the response", async () => {
  seen = [];
  reply = () => ok({ authorization_url: "https://checkout.paystack.com/abc", access_code: "ac", reference: "ref_1" });
  const r = await provider.initialize({
    reference: "ref_1", amountMinor: 150000, currency: "NGN", email: "a@b.test",
    callbackUrl: "https://app.test/cb", metadata: { milestoneId: "m1" },
  });
  expect(r.providerReference === "ref_1" && r.checkoutUrl === "https://checkout.paystack.com/abc", `result ${JSON.stringify(r)}`);
  const s = seen[0];
  expect(s.method === "POST" && s.url === "/transaction/initialize", `${s.method} ${s.url}`);
  expect(s.auth === `Bearer ${SECRET}`, "Authorization header");
  expect(s.body.amount === 150000 && Number.isInteger(s.body.amount), "amount is an integer in minor units");
  expect(s.body.currency === "NGN" && s.body.reference === "ref_1" && s.body.email === "a@b.test", "fields");
  expect(s.body.callback_url === "https://app.test/cb" && s.body.metadata.milestoneId === "m1", "optional fields sent");
});

test("initialize: optional fields are omitted when not given", async () => {
  seen = [];
  reply = () => ok({ authorization_url: "https://x.test/p", reference: "ref_2" });
  await provider.initialize({ reference: "ref_2", amountMinor: 1000, currency: "NGN", email: "a@b.test" });
  expect(!("callback_url" in seen[0].body) && !("metadata" in seen[0].body), "no callback_url/metadata keys");
});

test("initialize: gateway error becomes ProviderError with the HTTP status", async () => {
  reply = () => ({ status: 400, body: { status: false, message: "Duplicate Transaction Reference" } });
  const e = await rejects(() => provider.initialize({ reference: "dup", amountMinor: 1000, currency: "NGN", email: "a@b.test" }));
  expect(e instanceof ProviderError && e.httpStatus === 400 && /Duplicate/.test(e.message), `got ${String(e)}`);
});

test("initialize: a success response without a checkout URL is rejected", async () => {
  reply = () => ok({ reference: "ref_3" });
  const e = await rejects(() => provider.initialize({ reference: "ref_3", amountMinor: 1000, currency: "NGN", email: "a@b.test" }));
  expect(e instanceof ProviderError, `got ${String(e)}`);
});

test("verify: success maps amount, currency and channel", async () => {
  seen = [];
  reply = () => ok({ status: "success", amount: 150000, currency: "NGN", channel: "card" });
  const v = await provider.verify("ref_1");
  expect(v.found && v.status === "success" && v.amountMinor === 150000 && v.currency === "NGN" && v.channel === "card", JSON.stringify(v));
  expect(seen[0].method === "GET" && seen[0].url === "/transaction/verify/ref_1", seen[0].url);
});

test("verify: failed is failed; abandoned and unknown statuses stay pending", async () => {
  for (const [raw, want] of [["failed", "failed"], ["abandoned", "pending"], ["ongoing", "pending"]] as const) {
    reply = () => ok({ status: raw, amount: 1000, currency: "NGN", channel: null });
    const v = await provider.verify("r");
    expect(v.found && v.status === want, `${raw} -> ${JSON.stringify(v)}`);
  }
});

test("verify: the reference is URL-encoded", async () => {
  seen = [];
  reply = () => ok({ status: "success", amount: 1, currency: "NGN" });
  await provider.verify("a/b c");
  expect(seen[0].url === "/transaction/verify/a%2Fb%20c", seen[0].url);
});

test("verify: unknown reference is { found: false } (404 and 'not found' message)", async () => {
  reply = () => ({ status: 404, body: { status: false, message: "Transaction reference not found" } });
  expect(!(await provider.verify("nope")).found, "404 case");
  reply = () => ({ status: 400, body: { status: false, message: "Transaction reference not found" } });
  expect(!(await provider.verify("nope")).found, "400 case");
});

test("verify: other gateway errors are ProviderError, not 'not found'", async () => {
  reply = () => ({ status: 500, body: { status: false, message: "Internal error" } });
  const e = await rejects(() => provider.verify("r"));
  expect(e instanceof ProviderError && e.httpStatus === 500, `got ${String(e)}`);
});

test("network failure is a ProviderError", async () => {
  const dead = createPaystackProvider(SECRET, "http://127.0.0.1:1");
  const e = await rejects(() => dead.verify("r"));
  expect(e instanceof ProviderError && /unreachable/i.test(e.message), `got ${String(e)}`);
});

test("webhook signature: HMAC-SHA512 of the raw body, constant-time, strict", async () => {
  const body = `{"event":"charge.success","data":{"reference":"r1"}}`;
  const sig = createHmac("sha512", SECRET).update(body).digest("hex");
  expect(provider.verifyWebhookSignature(body, sig), "valid signature");
  expect(provider.verifyWebhookSignature(body, sig.toUpperCase()), "hex case does not matter");
  expect(!provider.verifyWebhookSignature(body + " ", sig), "tampered body");
  expect(!provider.verifyWebhookSignature(body, createHmac("sha512", "other").update(body).digest("hex")), "wrong secret");
  expect(!provider.verifyWebhookSignature(body, undefined), "missing signature");
  expect(!provider.verifyWebhookSignature(body, ""), "empty signature");
  expect(!provider.verifyWebhookSignature(body, "abc"), "short signature does not throw");
});

test("parseWebhook: envelope shapes", async () => {
  const a = provider.parseWebhook(`{"event":"charge.success","data":{"reference":"r1"}}`);
  expect(a?.type === "charge.success" && a.reference === "r1", JSON.stringify(a));
  const b = provider.parseWebhook(`{"event":"transfer.success"}`);
  expect(b?.type === "transfer.success" && b.reference === null, JSON.stringify(b));
  expect(provider.parseWebhook(`{"event":"charge.success","data":{"reference":42}}`)?.reference === null, "non-string reference");
  expect(provider.parseWebhook("not json") === null, "invalid JSON");
  expect(provider.parseWebhook(`{"data":{}}`) === null, "missing event");
});

async function main() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  provider = createPaystackProvider(SECRET, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); }
    catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
