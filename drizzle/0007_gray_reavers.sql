CREATE TABLE "ai_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"input_chars" integer DEFAULT 0 NOT NULL,
	"output_chars" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_daily" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_daily_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"threshold_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"required_role" "org_role" DEFAULT 'finance_approver' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"project_id" uuid,
	"requested_by_user_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"required_role" "org_role",
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_service_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"performed_on" date NOT NULL,
	"summary" text NOT NULL,
	"provider_profile_id" uuid,
	"project_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"organisation_id" uuid,
	"site_id" uuid,
	"project_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"model" text,
	"serial" text,
	"installed_on" date,
	"installed_by_provider_profile_id" uuid,
	"location_note" text,
	"next_service_on" date,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	CONSTRAINT "availability_exceptions_chk" CHECK ("availability_exceptions"."ends_at" > "availability_exceptions"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"assignment_id" uuid,
	"provider_profile_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"travel_buffer_min" integer DEFAULT 0 NOT NULL,
	"cancellation_policy_key" text,
	"proposed_by_user_id" uuid NOT NULL,
	"note" text,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_time_chk" CHECK ("bookings"."ends_at" > "bookings"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "cancellation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"market_id" uuid,
	"category_key" text,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"no_show" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cancellation_policies_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"eta_minutes" integer,
	"approx_lat" numeric(8, 3),
	"approx_lng" numeric(9, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_reads" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_reads_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "cost_centres" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"department_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "cost_centres_uniq" UNIQUE("organisation_id","code")
);
--> statement-breakpoint
CREATE TABLE "dispute_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"opened_by_user_id" uuid NOT NULL,
	"against_user_id" uuid,
	"reason" text NOT NULL,
	"description" text,
	"amount_minor" bigint,
	"currency" char(3),
	"status" text DEFAULT 'open' NOT NULL,
	"prior_scope_status" text,
	"resolution_kind" text,
	"resolution" text,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"insurer" text,
	"policy_ref" text,
	"cover_minor" bigint,
	"currency" char(3),
	"expires_on" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'other' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_user_id" uuid,
	"affected_task_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"due_at" timestamp with time zone,
	"resolution" text,
	"raised_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merchant_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "merchant_order_items_qty_chk" CHECK ("merchant_order_items"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "merchant_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_user_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"status" text DEFAULT 'created' NOT NULL,
	"payment_state" "payment_state" DEFAULT 'created' NOT NULL,
	"currency" char(3) NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"tax_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delivery" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"organisation_id" uuid,
	"market_id" uuid,
	"display_name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_owner_uniq" UNIQUE("owner_user_id")
);
--> statement-breakpoint
CREATE TABLE "message_confirmations" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_confirmations_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message_transcripts" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"language" text,
	"text" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"confidence" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_user_id" uuid,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"kind_prefix" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"quiet_start" text,
	"quiet_end" text,
	CONSTRAINT "notification_preferences_user_id_channel_kind_prefix_pk" PRIMARY KEY("user_id","channel","kind_prefix")
);
--> statement-breakpoint
CREATE TABLE "org_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"department_id" uuid,
	"cost_centre_id" uuid,
	"label" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"spend_limit_minor" bigint,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_budgets_chk" CHECK ("org_budgets"."amount_minor" >= 0 and "org_budgets"."period_end" >= "org_budgets"."period_start")
);
--> statement-breakpoint
CREATE TABLE "org_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_departments_uniq" UNIQUE("organisation_id","name")
);
--> statement-breakpoint
CREATE TABLE "org_preferred_providers" (
	"organisation_id" uuid NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"category_key" text DEFAULT '' NOT NULL,
	"note" text,
	CONSTRAINT "org_preferred_providers_organisation_id_provider_profile_id_category_key_pk" PRIMARY KEY("organisation_id","provider_profile_id","category_key")
);
--> statement-breakpoint
CREATE TABLE "org_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"department_id" uuid,
	"name" text NOT NULL,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"region_ref" text,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_sites_uniq" UNIQUE("organisation_id","name")
);
--> statement-breakpoint
CREATE TABLE "platform_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "procurement_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_request_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"product_id" uuid,
	"unit_price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"lead_days" integer,
	"note" text,
	"status" text DEFAULT 'submitted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "procurement_quotes_uniq" UNIQUE("procurement_request_id","merchant_id")
);
--> statement-breakpoint
CREATE TABLE "procurement_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"requested_by_user_id" uuid NOT NULL,
	"specification" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'need_identified' NOT NULL,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_key" text,
	"price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"stock" integer,
	"warranty_months" smallint DEFAULT 0 NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_uniq" UNIQUE("merchant_id","sku"),
	CONSTRAINT "products_price_chk" CHECK ("products"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "programme_participants" (
	"programme_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'enrolled' NOT NULL,
	"assessment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programme_participants_programme_id_user_id_pk" PRIMARY KEY("programme_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "programmes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"region" text,
	"starts_on" date,
	"ends_on" date,
	"goals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programmes_uniq" UNIQUE("organisation_id","name")
);
--> statement-breakpoint
CREATE TABLE "project_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"uploader_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"storage_path" text,
	"mime_type" text,
	"size_bytes" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_document_id" uuid,
	"managers_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"requester_user_id" uuid NOT NULL,
	"template_version_id" uuid,
	"source" text NOT NULL,
	"status" text DEFAULT 'validated' NOT NULL,
	"language" text,
	"payload" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_interaction_id" uuid,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category_key" text,
	"owner_kind" text DEFAULT 'platform' NOT NULL,
	"owner_organisation_id" uuid,
	"owner_user_id" uuid,
	"visibility" text DEFAULT 'global' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_templates_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "project_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"author_user_id" uuid NOT NULL,
	"kind" text DEFAULT 'progress' NOT NULL,
	"body" text NOT NULL,
	"language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promoted_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"category_key" text NOT NULL,
	"market_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promoted_listings_chk" CHECK ("promoted_listings"."ends_at" > "promoted_listings"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "provider_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_minute" smallint NOT NULL,
	"end_minute" smallint NOT NULL,
	"timezone" text NOT NULL,
	CONSTRAINT "provider_availability_chk" CHECK ("provider_availability"."weekday" between 0 and 6 and "provider_availability"."start_minute" between 0 and 1439 and "provider_availability"."end_minute" between 1 and 1440 and "provider_availability"."end_minute" > "provider_availability"."start_minute")
);
--> statement-breakpoint
CREATE TABLE "provider_team_members" (
	"team_id" uuid NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"revenue_share_bps" integer DEFAULT 0 NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_team_members_team_id_provider_profile_id_pk" PRIMARY KEY("team_id","provider_profile_id"),
	CONSTRAINT "provider_team_members_share_chk" CHECK ("provider_team_members"."revenue_share_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "provider_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"leader_provider_profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recurring_service_id" uuid NOT NULL,
	"due_on" date NOT NULL,
	"project_id" uuid,
	"status" text DEFAULT 'generated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_occurrences_uniq" UNIQUE("recurring_service_id","due_on")
);
--> statement-breakpoint
CREATE TABLE "recurring_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"organisation_id" uuid,
	"site_id" uuid,
	"title" text NOT NULL,
	"category_key" text,
	"frequency" text NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"next_due_on" date NOT NULL,
	"timezone" text NOT NULL,
	"currency" char(3) NOT NULL,
	"market_id" uuid NOT NULL,
	"task_template" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_provider_profile_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_services_interval_chk" CHECK ("recurring_services"."interval_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_class" text NOT NULL,
	"market_id" uuid,
	"retain_days" integer NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "safety_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"reporter_user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"description" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'reported' NOT NULL,
	"emergency_services_contacted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"category_key" text,
	"response_minutes" integer,
	"arrival_minutes" integer,
	"resolution_minutes" integer,
	"completion_hours" integer,
	"escalation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subcontract_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"requested_by_provider_id" uuid NOT NULL,
	"subcontractor_provider_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"language" text NOT NULL,
	"body" jsonb NOT NULL,
	"source_kind" text DEFAULT 'platform' NOT NULL,
	"author_user_id" uuid,
	"market_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"regulations" text[] DEFAULT '{}'::text[] NOT NULL,
	"effective_from" date,
	"approval_state" text DEFAULT 'draft' NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"superseded_by_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_versions_uniq" UNIQUE("template_id","version")
);
--> statement-breakpoint
CREATE TABLE "warranties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"project_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"grantor" text,
	"provider_profile_id" uuid,
	"merchant_id" uuid,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"terms" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warranties_dates_chk" CHECK ("warranties"."ends_on" >= "warranties"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "warranty_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warranty_id" uuid NOT NULL,
	"claimant_user_id" uuid NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_service_history" ADD CONSTRAINT "asset_service_history_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_service_history" ADD CONSTRAINT "asset_service_history_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_service_history" ADD CONSTRAINT "asset_service_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_service_history" ADD CONSTRAINT "asset_service_history_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_site_id_org_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."org_sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_installed_by_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("installed_by_provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_policies" ADD CONSTRAINT "cancellation_policies_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_centres" ADD CONSTRAINT "cost_centres_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_centres" ADD CONSTRAINT "cost_centres_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_entries" ADD CONSTRAINT "dispute_entries_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_entries" ADD CONSTRAINT "dispute_entries_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_against_user_id_users_id_fk" FOREIGN KEY ("against_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_records" ADD CONSTRAINT "insurance_records_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_records" ADD CONSTRAINT "insurance_records_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_raised_by_user_id_users_id_fk" FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_order_items" ADD CONSTRAINT "merchant_order_items_order_id_merchant_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."merchant_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_order_items" ADD CONSTRAINT "merchant_order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_confirmations" ADD CONSTRAINT "message_confirmations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_confirmations" ADD CONSTRAINT "message_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_budgets" ADD CONSTRAINT "org_budgets_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_budgets" ADD CONSTRAINT "org_budgets_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_budgets" ADD CONSTRAINT "org_budgets_cost_centre_id_cost_centres_id_fk" FOREIGN KEY ("cost_centre_id") REFERENCES "public"."cost_centres"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_budgets" ADD CONSTRAINT "org_budgets_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_preferred_providers" ADD CONSTRAINT "org_preferred_providers_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_preferred_providers" ADD CONSTRAINT "org_preferred_providers_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_sites" ADD CONSTRAINT "org_sites_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_sites" ADD CONSTRAINT "org_sites_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_quotes" ADD CONSTRAINT "procurement_quotes_procurement_request_id_procurement_requests_id_fk" FOREIGN KEY ("procurement_request_id") REFERENCES "public"."procurement_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_quotes" ADD CONSTRAINT "procurement_quotes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_quotes" ADD CONSTRAINT "procurement_quotes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_quotes" ADD CONSTRAINT "procurement_quotes_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_requests" ADD CONSTRAINT "procurement_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_requests" ADD CONSTRAINT "procurement_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_requests" ADD CONSTRAINT "procurement_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_requests" ADD CONSTRAINT "procurement_requests_order_id_merchant_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."merchant_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programme_participants" ADD CONSTRAINT "programme_participants_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "public"."programmes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programme_participants" ADD CONSTRAINT "programme_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programmes" ADD CONSTRAINT "programmes_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_uploader_user_id_users_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_drafts" ADD CONSTRAINT "project_drafts_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_drafts" ADD CONSTRAINT "project_drafts_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_drafts" ADD CONSTRAINT "project_drafts_template_version_id_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."template_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_drafts" ADD CONSTRAINT "project_drafts_ai_interaction_id_ai_interactions_id_fk" FOREIGN KEY ("ai_interaction_id") REFERENCES "public"."ai_interactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_drafts" ADD CONSTRAINT "project_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_owner_organisation_id_organisations_id_fk" FOREIGN KEY ("owner_organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_updates" ADD CONSTRAINT "project_updates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_updates" ADD CONSTRAINT "project_updates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_updates" ADD CONSTRAINT "project_updates_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promoted_listings" ADD CONSTRAINT "promoted_listings_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promoted_listings" ADD CONSTRAINT "promoted_listings_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promoted_listings" ADD CONSTRAINT "promoted_listings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_availability" ADD CONSTRAINT "provider_availability_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_team_members" ADD CONSTRAINT "provider_team_members_team_id_provider_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."provider_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_team_members" ADD CONSTRAINT "provider_team_members_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_teams" ADD CONSTRAINT "provider_teams_leader_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("leader_provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_occurrences" ADD CONSTRAINT "recurring_occurrences_recurring_service_id_recurring_services_id_fk" FOREIGN KEY ("recurring_service_id") REFERENCES "public"."recurring_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_occurrences" ADD CONSTRAINT "recurring_occurrences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_services" ADD CONSTRAINT "recurring_services_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_services" ADD CONSTRAINT "recurring_services_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_services" ADD CONSTRAINT "recurring_services_site_id_org_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."org_sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_services" ADD CONSTRAINT "recurring_services_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_services" ADD CONSTRAINT "recurring_services_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_services" ADD CONSTRAINT "recurring_services_preferred_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("preferred_provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_requests" ADD CONSTRAINT "subcontract_requests_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_requests" ADD CONSTRAINT "subcontract_requests_requested_by_provider_id_provider_profiles_id_fk" FOREIGN KEY ("requested_by_provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_requests" ADD CONSTRAINT "subcontract_requests_subcontractor_provider_id_provider_profiles_id_fk" FOREIGN KEY ("subcontractor_provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_requests" ADD CONSTRAINT "subcontract_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_project_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."project_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_language_languages_code_fk" FOREIGN KEY ("language") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_warranty_id_warranties_id_fk" FOREIGN KEY ("warranty_id") REFERENCES "public"."warranties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_claimant_user_id_users_id_fk" FOREIGN KEY ("claimant_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_interactions_user_idx" ON "ai_interactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "approval_policies_org_idx" ON "approval_policies" USING btree ("organisation_id","subject_type");--> statement-breakpoint
CREATE INDEX "approval_requests_org_idx" ON "approval_requests" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE INDEX "approval_requests_subject_idx" ON "approval_requests" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "assets_owner_idx" ON "assets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "assets_next_service_idx" ON "assets" USING btree ("next_service_on");--> statement-breakpoint
CREATE INDEX "bookings_provider_idx" ON "bookings" USING btree ("provider_profile_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_task_idx" ON "bookings" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "check_ins_task_idx" ON "check_ins" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "dispute_entries_idx" ON "dispute_entries" USING btree ("dispute_id","created_at");--> statement-breakpoint
CREATE INDEX "disputes_project_idx" ON "disputes" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "disputes_scope_idx" ON "disputes" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "insurance_records_provider_idx" ON "insurance_records" USING btree ("provider_profile_id","kind");--> statement-breakpoint
CREATE INDEX "issues_project_idx" ON "issues" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "merchant_orders_buyer_idx" ON "merchant_orders" USING btree ("buyer_user_id","status");--> statement-breakpoint
CREATE INDEX "merchant_orders_merchant_idx" ON "merchant_orders" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX "moderation_reports_status_idx" ON "moderation_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "platform_events_kind_idx" ON "platform_events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_status_idx" ON "privacy_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "procurement_requests_project_idx" ON "procurement_requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "project_documents_project_idx" ON "project_documents" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "project_drafts_requester_idx" ON "project_drafts" USING btree ("requester_user_id","status");--> statement-breakpoint
CREATE INDEX "project_templates_category_idx" ON "project_templates" USING btree ("category_key");--> statement-breakpoint
CREATE INDEX "project_updates_project_idx" ON "project_updates" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "promoted_listings_idx" ON "promoted_listings" USING btree ("category_key","ends_at");--> statement-breakpoint
CREATE INDEX "provider_availability_idx" ON "provider_availability" USING btree ("provider_profile_id","weekday");--> statement-breakpoint
CREATE INDEX "recurring_services_due_idx" ON "recurring_services" USING btree ("is_active","next_due_on");--> statement-breakpoint
CREATE INDEX "retention_policies_class_idx" ON "retention_policies" USING btree ("data_class");--> statement-breakpoint
CREATE INDEX "safety_incidents_status_idx" ON "safety_incidents" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "subcontract_requests_assignment_idx" ON "subcontract_requests" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "template_versions_state_idx" ON "template_versions" USING btree ("template_id","approval_state");--> statement-breakpoint
CREATE INDEX "warranties_owner_idx" ON "warranties" USING btree ("owner_user_id","ends_on");