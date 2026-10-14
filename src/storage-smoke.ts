import "dotenv/config";
import { getStorage } from "./lib/storage.js";

// Live check of the Supabase Storage adapter (src/lib/storage.ts), no API or database involved.
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and a PRIVATE bucket (default name: request-media).
// Run: npm run storage:smoke
async function main() {
  const s = getStorage();
  const key = `smoke/${Date.now()}.jpg`;
  const bytes = new Uint8Array(1024).fill(7);
  const step = (ok: boolean, name: string, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`); if (!ok) process.exitCode = 1; return ok; };
  try {
    const up = await s.createUpload(key, "image/jpeg");
    if (!step(up.method === "PUT" && up.url.startsWith("http"), "createUpload returns a signed PUT url")) return;
    const put = await fetch(up.url, { method: "PUT", headers: up.headers, body: bytes });
    if (!step(put.ok, "device-style PUT of 1 KB succeeds", `status ${put.status}`)) { console.log(await put.text()); return; }
    const head = await s.head(key);
    if (!step(head?.sizeBytes === 1024, "head finds the object with the right size", JSON.stringify(head))) return;
    const url = await s.createDownloadUrl(key, 60);
    const got = await fetch(url);
    step(got.ok && (await got.arrayBuffer()).byteLength === 1024, "signed download url returns the file", `status ${got.status}`);
    const anon = await fetch(url.split("?")[0]);
    step(!anon.ok, "the same path WITHOUT the signature is refused (bucket is private)", `status ${anon.status}`);
  } finally {
    try { await s.remove(key); const gone = await s.head(key); step(gone === null, "remove deletes the object"); } catch (e) { step(false, "cleanup", (e as Error).message); }
  }
}
main().catch((e) => { console.log(`FAIL  ${(e as Error).message}`); process.exit(1); });
