import { sql } from "drizzle-orm";
import { bigint, char, check, index, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_common.js";
import { users } from "./identity.js";
import { requests } from "./projects.js";

// Request intake (PRD §17, §37, §141): the user's answers to the guided questions and the photos/videos/documents
// that show the problem. Own file and own enums so it stays self-contained. DECISIONS D38-D40.

export const attachmentKind = pgEnum("attachment_kind", ["photo", "video", "document"]);
export const attachmentStatus = pgEnum("attachment_status", ["pending", "ready"]);

// One row per question; the value is validated against the question definition in src/engine/intake-questions.ts.
export const requestAnswers = pgTable("request_answers", {
  requestId: uuid("request_id").notNull().references(() => requests.id, { onDelete: "cascade" }),
  questionKey: text("question_key").notNull(),
  value: jsonb("value").$type<boolean | number | string>().notNull(),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.requestId, t.questionKey] })]);

// The file itself lives in private object storage; this row is the record. `pending` = upload URL issued,
// `ready` = the object was found in storage and its real size recorded (confirm step).
export const requestAttachments = pgTable("request_attachments", {
  id: pk(),
  requestId: uuid("request_id").notNull().references(() => requests.id, { onDelete: "cascade" }),
  uploadedByUserId: uuid("uploaded_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: attachmentKind("kind").notNull(),
  status: attachmentStatus("status").notNull().default("pending"),
  storageKey: text("storage_key").notNull().unique(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  originalFilename: text("original_filename"),
  // Hash REPORTED by the uploading device (PRD §67): useful for disputes, never presented as proof.
  sha256: char("sha256", { length: 64 }),
  createdAt: createdAt(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
}, (t) => [
  index("request_attachments_request_idx").on(t.requestId, t.status),
  check("request_attachments_size_chk", sql`${t.sizeBytes} > 0`),
]);
