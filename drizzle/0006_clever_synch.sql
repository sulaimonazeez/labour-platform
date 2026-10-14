CREATE TYPE "public"."attachment_kind" AS ENUM('photo', 'video', 'document');--> statement-breakpoint
CREATE TYPE "public"."attachment_status" AS ENUM('pending', 'ready');--> statement-breakpoint
CREATE TABLE "request_answers" (
	"request_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_answers_request_id_question_key_pk" PRIMARY KEY("request_id","question_key")
);
--> statement-breakpoint
CREATE TABLE "request_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"kind" "attachment_kind" NOT NULL,
	"status" "attachment_status" DEFAULT 'pending' NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"original_filename" text,
	"sha256" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "request_attachments_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "request_attachments_size_chk" CHECK ("request_attachments"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "request_answers" ADD CONSTRAINT "request_answers_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_attachments_request_idx" ON "request_attachments" USING btree ("request_id","status");