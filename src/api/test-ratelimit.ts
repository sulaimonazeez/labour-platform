import "dotenv/config";
import { like } from "drizzle-orm";
import { app } from "./app.js";
import { db, queryClient } from "../db/client.js";
import { rateLimitHits } from "../db/schema/index.js";
import { checkLimit } from "../auth/rate-limit.js";

// Runs with the limiter ENABLED (do not set RATE_LIMIT_DISABLED). Uses unique keys / fake IPs
// and removes its own counters at the end.
const tag = `rltest-${Date.now().toString(36)}`;
let failed = 0;
const pass = (n: string) => console.log(`PASS  ${n}`);
const fail = (n: string, m: string) => { failed++; console.log(`FAIL  ${n}\n      ${m}`); };

async function main() {
  try {
    { const w = Date.now() % 60000; if (w > 50000) await new Promise((r) => setTimeout(r, 60000 - w + 200)); }
    // 1. checkLimit counts and then blocks
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await checkLimit(`${tag}:a`, 3, 60)).ok);
    if (results.join() === "true,true,true,false") pass("checkLimit: allows up to the limit, then blocks");
    else fail("checkLimit: allows up to the limit, then blocks", `got ${results.join()}`);

    // 2. keys are independent
    const other = await checkLimit(`${tag}:b`, 3, 60);
    if (other.ok) pass("checkLimit: separate keys do not share a counter");
    else fail("checkLimit: separate keys do not share a counter", "key b was blocked");

    // 3. login route: per-IP limit returns 429 with Retry-After
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const body = JSON.stringify({ email: `${tag}@test.invalid`, password: "whatever-password" });
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 31; i++) {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
        body,
      });
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get("retry-after");
    }
    const blocked = statuses.filter((s) => s === 429).length;
    // Per-email cap is 10 per window, so 429s appear after 10 attempts (email limit hits first).
    if (statuses.slice(0, 10).every((s) => s === 401) && blocked >= 1 && retryAfter) pass("login: repeated attempts get 429 with Retry-After");
    else fail("login: repeated attempts get 429 with Retry-After", `statuses=${statuses.join(",")} retry-after=${retryAfter}`);
  } finally {
    await db.delete(rateLimitHits).where(like(rateLimitHits.key, `${tag}%`));
    await db.delete(rateLimitHits).where(like(rateLimitHits.key, "login:ip:203.0.113.%"));
    await queryClient.end();
  }
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
}
main();
