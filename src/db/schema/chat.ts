import {
  index, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk } from "./_common.js";
import { languages } from "./config.js";
import { users } from "./identity.js";
import { projects, tasks } from "./projects.js";
import { conversationContext } from "./enums.js";

// PRD §31-32: one conversation per (context_type, context_id).
// Convention: for context_type='project', context_id = project id.
export const conversations = pgTable("conversations", {
  id: pk(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  contextType: conversationContext("context_type").notNull(),
  contextId: uuid("context_id").notNull(),
  createdAt: createdAt(),
}, (t) => [
  unique("conversations_context_uniq").on(t.contextType, t.contextId),
  index("conversations_project_idx").on(t.projectId),
]);

// PRD §34: access follows explicit participation, not blanket project membership.
export const conversationParticipants = pgTable("conversation_participants", {
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.conversationId, t.userId] })]);

// PRD §28-29: original text is never overwritten (guarded in sql/guards.sql).
export const messages = pgTable("messages", {
  id: pk(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id),
  senderUserId: uuid("sender_user_id").notNull().references(() => users.id),
  originalText: text("original_text").notNull(),
  originalLanguage: text("original_language").references(() => languages.code),
  clientMessageId: text("client_message_id"), // retry-safe sends (PRD §136)
  attachments: jsonb("attachments").$type<unknown[]>().notNull().default([]),
  createdAt: createdAt(),
}, (t) => [
  unique("messages_client_id_uniq").on(t.senderUserId, t.clientMessageId),
  index("messages_conversation_idx").on(t.conversationId, t.createdAt),
]);

export const messageTranslations = pgTable("message_translations", {
  id: pk(),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  targetLanguage: text("target_language").notNull().references(() => languages.code),
  translatedText: text("translated_text").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  createdAt: createdAt(),
}, (t) => [unique("message_translations_uniq").on(t.messageId, t.targetLanguage, t.provider)]);
