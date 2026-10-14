import { bigint, timestamp, uuid } from "drizzle-orm/pg-core";

export const pk = () => uuid("id").primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Money is ALWAYS integer minor units, stored next to an explicit currency
 * column (PRD §45). Never a float, never an inferred currency.
 */
export const minor = (name: string) => bigint(name, { mode: "number" });
