import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const url = process.env.DIRECT_URL;
if (!url) throw new Error("DIRECT_URL is not set");

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "..", "sql", "guards.sql");

const sql = postgres(url, { max: 1 });
try {
  // No parameters => postgres.js uses the simple protocol, which allows multiple statements.
  await sql.unsafe(readFileSync(file, "utf8"));
  console.log("guards applied");
} finally {
  await sql.end();
}
