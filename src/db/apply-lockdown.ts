import "dotenv/config";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema/index.js";

// Plain-Postgres lockdown (D2): Supabase's REST API must not be able to touch OUR tables.
// Scope: ONLY tables defined in src/db/schema. Other apps' tables in the same database are never touched.
// (An earlier version acted on every table in `public` and broke a neighbouring app: see CHANGELOG.)
// Idempotent. Re-run after every db:migrate that creates tables.
const url = process.env.DIRECT_URL;
if (!url) throw new Error("DIRECT_URL is not set");
const sql = postgres(url, { max: 1, onnotice: () => {} });

// `is()` is a runtime check; cast the filtered values so TypeScript sees plain tables (not enums/other exports).
const ours = (Object.values(schema) as unknown[])
  .filter((x) => is(x, PgTable))
  .map((x) => getTableName(x as PgTable));

for (const n of ours) if (!/^[a-z][a-z0-9_]*$/.test(n)) throw new Error(`Unexpected table name: ${n}`);
const list = ours.map((n) => `'${n}'`).join(",");

async function main() {
  const roles = await sql<{ rolname: string }[]>`
    select rolname from pg_roles where rolname in ('anon', 'authenticated')`;
  const targets = roles.map((r) => r.rolname);

  for (const n of ours) {
    await sql.unsafe(`ALTER TABLE public."${n}" ENABLE ROW LEVEL SECURITY`);
    if (targets.length > 0) {
      await sql.unsafe(`REVOKE ALL ON TABLE public."${n}" FROM ${targets.join(", ")}`);
    }
  }

  const missing = await sql.unsafe(`
    select name from unnest(array[${list}]) as name
    where not exists (select 1 from pg_tables where schemaname = 'public' and tablename = name)`);
  const noRls = await sql.unsafe(`
    select count(*)::int as n from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and c.relname in (${list}) and not c.relrowsecurity`);
  const grants = await sql.unsafe(`
    select count(*)::int as n from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated') and table_name in (${list})`);
  const others = await sql.unsafe(`
    select count(*)::int as n from pg_tables
    where schemaname = 'public' and tablename not in (${list})`);

  console.log(`our tables defined in schema: ${ours.length}`);
  console.log(`our tables not yet in database: ${missing.length}${missing.length ? " -> " + missing.map((m: any) => m.name).join(", ") : ""}`);
  console.log(`our tables without RLS: ${noRls[0].n} (want 0)`);
  console.log(`anon/authenticated grants on our tables: ${grants[0].n} (want 0)`);
  console.log(`other tables in public left untouched: ${others[0].n}`);
  await sql.end();
  process.exit(noRls[0].n === 0 && grants[0].n === 0 && missing.length === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await sql.end({ timeout: 1 }).catch(() => {}); process.exit(1); });
