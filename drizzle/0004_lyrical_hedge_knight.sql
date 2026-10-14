CREATE TABLE "task_invitations" (
	"task_id" uuid NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"status" "candidate_status" DEFAULT 'invited' NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_invitations_task_id_provider_profile_id_pk" PRIMARY KEY("task_id","provider_profile_id")
);
--> statement-breakpoint
ALTER TABLE "task_invitations" ADD CONSTRAINT "task_invitations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_invitations" ADD CONSTRAINT "task_invitations_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_invitations" ADD CONSTRAINT "task_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_invitations_provider_idx" ON "task_invitations" USING btree ("provider_profile_id","status");