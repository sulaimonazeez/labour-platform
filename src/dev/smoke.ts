// Post-deploy smoke test against a RUNNING deployment:
//   npm run smoke -- https://your-project.vercel.app
// It registers ONE throwaway user (smoke-<time>@example.com) on that deployment's database and checks that the
// public surface behaves. It never creates payments or payouts. Test deployments only.
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) { console.error("Usage: npm run smoke -- https://<your-domain>"); process.exit(2); }

let failed = 0;
async function req(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const t0 = Date.now();
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text, ms: Date.now() - t0 };
}
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    console.log(`PASS  ${name}${note ? `  (${note})` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}
const must = (c: unknown, m: string) => { if (!c) throw new Error(m); };

async function main() {
  console.log(`Smoke test: ${base}\n`);
  let token = "";
  await check("GET /health", async () => {
    const r = await req("GET", "/health");
    must(r.status === 200 && r.json?.ok === true, `got ${r.status} ${r.text.slice(0, 120)} (a Vercel login page means you are on a protected preview URL: use the production domain)`);
    return `${r.ms} ms`;
  });
  await check("unknown path gives our JSON 404", async () => {
    const r = await req("GET", "/definitely-not-here");
    must(r.status === 404 && r.json?.error?.code === "not_found", `got ${r.status} ${r.text.slice(0, 120)}`);
  });
  await check("register a throwaway user (proves the database connection)", async () => {
    const r = await req("POST", "/auth/register", {
      body: { email: `smoke-${Date.now().toString(36)}@example.com`, password: "correct horse battery", displayName: "Smoke Test", preferredLanguage: "en", timezone: "Africa/Lagos", marketCode: "NG" },
    });
    must(r.status === 201 && typeof r.json?.token === "string", `got ${r.status} ${r.text.slice(0, 200)} (500 here usually means DATABASE_URL is wrong or the Supabase project is paused)`);
    token = r.json.token;
    return `${r.ms} ms`;
  });
  await check("GET /me works with the token and is 401 without", async () => {
    const a = await req("GET", "/me", { token });
    must(a.status === 200, `with token: ${a.status} ${a.text.slice(0, 120)}`);
    const b = await req("GET", "/me");
    must(b.status === 401, `without token: ${b.status}`);
  });
  await check("writes need an Idempotency-Key", async () => {
    const r = await req("POST", "/requests", { token, body: { rawText: "smoke" } });
    must(r.status === 400 && r.json?.error?.code === "idempotency_key_required", `got ${r.status} ${r.text.slice(0, 120)}`);
  });
  await check("unsigned Paystack webhook is rejected (401)", async () => {
    const r = await req("POST", "/webhooks/paystack", { body: { event: "charge.success", data: { reference: "x" } } });
    must(r.status === 401, `got ${r.status} ${r.text.slice(0, 160)} (503 means PAYMENTS_PROVIDER/PAYSTACK_SECRET_KEY is not set in Vercel)`);
  });
  await check("admin surface is hidden from ordinary users (404)", async () => {
    const r = await req("GET", "/admin/attention", { token });
    must(r.status === 404, `got ${r.status} ${r.text.slice(0, 120)}`);
  });
  await check("Paystack reachable from the deployment: bank list", async () => {
    const r = await req("GET", "/providers/banks?currency=NGN", { token });
    must(r.status === 200 && Array.isArray(r.json?.banks) && r.json.banks.length > 0, `got ${r.status} ${r.text.slice(0, 200)} (503 = payment provider not configured; 502 = Paystack rejected the key or is unreachable)`);
    return `${r.json.banks.length} banks, ${r.ms} ms`;
  });

  console.log(failed ? `\n${failed} check(s) failed.` : "\nDeployment looks healthy. Next: set the Paystack webhook URL, then run a real test checkout.");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
