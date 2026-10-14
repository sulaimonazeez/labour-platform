import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// prepare:false is required for Supabase/pgbouncer transaction-mode pooling.
// max:1 keeps each serverless instance to a single connection.
const queryClient = postgres(url, { prepare: false, max: 1 });

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;
export { queryClient };
