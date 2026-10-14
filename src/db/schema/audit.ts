import {
  index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk } from "./_common";
import { users } from "./identity";
import { projects } from "./projects";
import {
  actorType, notificationChannel, notificationStatus,
} from "./enums";

// PRD §68, §133, §137: canonical, append-only chronology generated from system events.
export const activityEvents = pgTable("activity_events", {
  id: pk(),
  projectId: uuid("project_id").references(() => projects.id),
  actorType: actorType("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  eventType: text("event_type").notNull(), // e.g. quote.accepted, milestone.approved
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("activity_events_project_idx").on(t.projectId, t.occurredAt),
  index("activity_events_subject_idx").on(t.subjectType, t.subjectId),
]);

// PRD §136
export const idempotencyKeys = pgTable("idempotency_keys", {
  scope: text("scope").notNull(), // e.g. 'payments.create', 'tasks.assign'
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body").$type<unknown>(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.scope, t.key] })]);

export const notifications = pgTable("notifications", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  channel: notificationChannel("channel").notNull().default("in_app"),
  language: text("language"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  status: notificationStatus("status").notNull().default("pending"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("notifications_user_idx").on(t.userId, t.status)]);
