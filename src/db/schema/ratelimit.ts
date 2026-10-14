import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// Fixed-window counters, shared across serverless instances (in-memory limits don't work on Vercel).
// `key` is a namespaced identifier such as "login:ip:<ip>" or "login:email:<sha256>".
export const rateLimitHits = pgTable("rate_limit_hits", {
  key: text("key").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.key, t.windowStart] })]).enableRLS();
