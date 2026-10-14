import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type * as schema from "./schema/index.js";

/**
 * Anything that can run queries: the top-level `db` or a transaction handle.
 * Helpers that must work in both (authz checks, activity writes) take this type.
 */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
