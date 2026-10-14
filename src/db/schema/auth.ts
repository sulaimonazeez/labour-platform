import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_common";
import { users } from "./identity";

export const userCredentials = pgTable("user_credentials", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  updatedAt: updatedAt(),
}).enableRLS();

export const sessions = pgTable("sessions", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), // sha256 of the opaque token; the raw token is never stored
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  userAgent: text("user_agent"),
}, (t) => [index("sessions_user_idx").on(t.userId)]).enableRLS();
