CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'admin', 'provider_webhook');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('offered', 'accepted', 'rejected', 'withdrawn', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."candidate_status" AS ENUM('invited', 'viewed', 'interested', 'quoted', 'negotiating', 'accepted', 'assigned', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."change_financial_effect" AS ENUM('no_cost', 'increase', 'reduction', 'credit', 'partial_cancellation');--> statement-breakpoint
CREATE TYPE "public"."change_status" AS ENUM('draft', 'proposed', 'under_review', 'accepted', 'rejected', 'withdrawn', 'applied');--> statement-breakpoint
CREATE TYPE "public"."conversation_context" AS ENUM('project', 'stage', 'task', 'quote', 'change_request', 'milestone', 'dispute', 'merchant_order', 'private');--> statement-breakpoint
CREATE TYPE "public"."dependency_type" AS ENUM('finish_to_start', 'start_to_start', 'external', 'material', 'approval', 'payment');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('photo_before', 'photo_progress', 'photo_after', 'video', 'checklist', 'measurement', 'signature', 'inspection', 'serial_number', 'document', 'receipt', 'sensor_data');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_kind" AS ENUM('external_clearing', 'protected_funds', 'provider_earnings', 'merchant_earnings', 'platform_fees', 'taxes_payable', 'payout_clearing', 'refunds', 'disputed_funds', 'promotional_credits', 'adjustments');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_kind" AS ENUM('payment_captured', 'funds_secured', 'milestone_released', 'fee_applied', 'payout', 'refund', 'adjustment', 'dispute_hold', 'dispute_release', 'chargeback', 'fx');--> statement-breakpoint
CREATE TYPE "public"."material_responsibility" AS ENUM('customer', 'provider', 'merchant', 'shared', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."measurement_system" AS ENUM('metric', 'imperial', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."milestone_status" AS ENUM('pending', 'funded', 'in_progress', 'submitted', 'approved', 'released', 'disputed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'push', 'email', 'sms', 'messaging');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed', 'read');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'member', 'finance_approver', 'procurement_officer', 'project_manager', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."org_type" AS ENUM('business', 'government', 'ngo', 'institution', 'service_company', 'merchant');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('created', 'pending', 'authorised', 'funded', 'secured', 'partially_released', 'released', 'failed', 'refunded', 'partially_refunded', 'disputed', 'chargeback');--> statement-breakpoint
CREATE TYPE "public"."payout_state" AS ENUM('pending', 'processing', 'paid', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."project_health" AS ENUM('on_track', 'attention_required', 'delayed', 'blocked', 'awaiting_customer', 'awaiting_provider', 'awaiting_material', 'awaiting_approval', 'awaiting_payment', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."project_role" AS ENUM('project_owner', 'project_manager', 'supervisor', 'provider', 'provider_team_member', 'consultant', 'inspector', 'merchant', 'procurement_officer', 'finance_approver', 'observer', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('draft', 'active', 'on_hold', 'completed', 'aftercare', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."provider_kind" AS ENUM('individual', 'company', 'team');--> statement-breakpoint
CREATE TYPE "public"."quote_line_kind" AS ENUM('labour', 'transport', 'inspection', 'equipment', 'materials', 'subcontractor', 'tax', 'platform_fee', 'optional', 'other');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'submitted', 'revision_requested', 'accepted', 'rejected', 'expired', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."request_path" AS ENUM('quick_service', 'ai_assisted', 'managed_project');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('draft', 'open', 'matched', 'converted', 'cancelled', 'closed');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."stage_status" AS ENUM('pending', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('draft', 'ready', 'offered', 'assigned', 'accepted', 'in_progress', 'submitted', 'approved', 'completed', 'blocked', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."verification_class" AS ENUM('contact', 'identity', 'address', 'business', 'skill', 'professional_licence', 'insurance', 'platform_performance');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'verified', 'rejected', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" char(3) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"minor_unit_exponent" smallint DEFAULT 2 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "languages" (
	"code" text PRIMARY KEY NOT NULL,
	"name_native" text NOT NULL,
	"name_english" text NOT NULL,
	"direction" text DEFAULT 'ltr' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "languages_direction_chk" CHECK ("languages"."direction" in ('ltr','rtl'))
);
--> statement-breakpoint
CREATE TABLE "market_compliance_settings" (
	"market_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_compliance_settings_market_id_key_pk" PRIMARY KEY("market_id","key")
);
--> statement-breakpoint
CREATE TABLE "market_currencies" (
	"market_id" uuid NOT NULL,
	"currency_code" char(3) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "market_currencies_market_id_currency_code_pk" PRIMARY KEY("market_id","currency_code")
);
--> statement-breakpoint
CREATE TABLE "market_holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"holiday_date" date NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "market_holidays_uniq" UNIQUE("market_id","holiday_date")
);
--> statement-breakpoint
CREATE TABLE "market_languages" (
	"market_id" uuid NOT NULL,
	"language_code" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "market_languages_market_id_language_code_pk" PRIMARY KEY("market_id","language_code")
);
--> statement-breakpoint
CREATE TABLE "market_payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"method_code" text NOT NULL,
	"provider_code" text NOT NULL,
	"supports_protected_payment" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "market_payment_methods_uniq" UNIQUE("market_id","method_code","provider_code")
);
--> statement-breakpoint
CREATE TABLE "market_service_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"is_allowed" boolean DEFAULT true NOT NULL,
	"required_credentials" jsonb,
	"protected_payment_allowed" boolean,
	"insurance_requirements" jsonb,
	CONSTRAINT "market_service_rules_uniq" UNIQUE("market_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "market_tax_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"tax_code" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	CONSTRAINT "market_tax_rules_rate_chk" CHECK ("market_tax_rules"."rate_bps" >= 0)
);
--> statement-breakpoint
CREATE TABLE "market_verification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"verification_class" "verification_class" NOT NULL,
	"adapter_code" text NOT NULL,
	"accepted_documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_for_payout" boolean DEFAULT false NOT NULL,
	CONSTRAINT "market_verification_rules_uniq" UNIQUE("market_id","verification_class")
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"parent_market_id" uuid,
	"name" text NOT NULL,
	"default_language" text NOT NULL,
	"default_currency" char(3) NOT NULL,
	"default_timezone" text NOT NULL,
	"measurement_system" "measurement_system" NOT NULL,
	"address_format" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"working_days" jsonb NOT NULL,
	"business_hours" jsonb,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "service_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text NOT NULL,
	"parent_id" uuid,
	"meaning" text NOT NULL,
	"risk_level" "risk_level" DEFAULT 'low' NOT NULL,
	"required_credentials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_categories_canonical_key_unique" UNIQUE("canonical_key")
);
--> statement-breakpoint
CREATE TABLE "service_category_synonyms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"language_code" text NOT NULL,
	"term" text NOT NULL,
	CONSTRAINT "service_category_synonyms_uniq" UNIQUE("category_id","language_code","term")
);
--> statement-breakpoint
CREATE TABLE "service_category_translations" (
	"category_id" uuid NOT NULL,
	"language_code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "service_category_translations_category_id_language_code_pk" PRIMARY KEY("category_id","language_code")
);
--> statement-breakpoint
CREATE TABLE "organisation_members" (
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "org_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_members_organisation_id_user_id_role_pk" PRIMARY KEY("organisation_id","user_id","role")
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "org_type" NOT NULL,
	"market_id" uuid,
	"parent_organisation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organisation_id" uuid,
	"kind" "provider_kind" DEFAULT 'individual' NOT NULL,
	"display_name" text NOT NULL,
	"headline" text,
	"bio" text,
	"approx_lat" numeric(9, 6),
	"approx_lng" numeric(9, 6),
	"service_radius_km" integer,
	"remote_ok" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "provider_services" (
	"provider_profile_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"pricing_approach" text,
	"years_experience" smallint,
	CONSTRAINT "provider_services_provider_profile_id_category_id_pk" PRIMARY KEY("provider_profile_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"phone" text,
	"display_name" text NOT NULL,
	"preferred_language" text NOT NULL,
	"secondary_languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_translate" boolean DEFAULT true NOT NULL,
	"show_original_by_default" boolean DEFAULT false NOT NULL,
	"timezone" text NOT NULL,
	"market_id" uuid,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_contact_chk" CHECK ("users"."email" is not null or "users"."phone" is not null)
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_profile_id" uuid,
	"verification_class" "verification_class" NOT NULL,
	"status" "verification_status" DEFAULT 'pending' NOT NULL,
	"issuer" text,
	"market_id" uuid,
	"issued_at" date,
	"expires_at" date,
	"document_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_budgets" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"currency" char(3) NOT NULL,
	"estimated_minor" bigint,
	"approved_minor" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "project_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_role_pk" PRIMARY KEY("project_id","user_id","role")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"organisation_id" uuid,
	"request_id" uuid,
	"market_id" uuid NOT NULL,
	"title" text NOT NULL,
	"objective" text,
	"status" "project_status" DEFAULT 'draft' NOT NULL,
	"health" "project_health" DEFAULT 'on_track' NOT NULL,
	"currency" char(3) NOT NULL,
	"timezone" text NOT NULL,
	"current_baseline_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "request_candidates" (
	"request_id" uuid NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"status" "candidate_status" DEFAULT 'invited' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_candidates_request_id_provider_profile_id_pk" PRIMARY KEY("request_id","provider_profile_id")
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"organisation_id" uuid,
	"market_id" uuid NOT NULL,
	"category_id" uuid,
	"raw_text" text,
	"original_language" text,
	"path" "request_path" DEFAULT 'quick_service' NOT NULL,
	"status" "request_status" DEFAULT 'draft' NOT NULL,
	"site_location" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"status" "stage_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"type" "dependency_type" DEFAULT 'finish_to_start' NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_task_id_type_pk" PRIMARY KEY("task_id","depends_on_task_id","type"),
	CONSTRAINT "task_dependencies_self_chk" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"stage_id" uuid,
	"category_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'draft' NOT NULL,
	"material_responsibility" "material_responsibility" DEFAULT 'not_applicable' NOT NULL,
	"evidence_requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"planned_start" timestamp with time zone,
	"planned_end" timestamp with time zone,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"quote_id" uuid,
	"status" "assignment_status" DEFAULT 'offered' NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_version_id" uuid NOT NULL,
	"kind" "quote_line_kind" NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(14, 3) DEFAULT '1' NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"amount_minor" bigint NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"total_minor" bigint NOT NULL,
	"valid_until" timestamp with time zone,
	"inspection_required" boolean DEFAULT false NOT NULL,
	"exclusions" text,
	"notes" text,
	"created_by_user_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_versions_uniq" UNIQUE("quote_id","version"),
	CONSTRAINT "quote_versions_total_chk" CHECK ("quote_versions"."total_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"project_id" uuid,
	"task_id" uuid,
	"provider_profile_id" uuid NOT NULL,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"accepted_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_target_chk" CHECK ("quotes"."request_id" is not null or "quotes"."project_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "change_request_tasks" (
	"change_request_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	CONSTRAINT "change_request_tasks_change_request_id_task_id_pk" PRIMARY KEY("change_request_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" "change_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"financial_effect" "change_financial_effect" DEFAULT 'no_cost' NOT NULL,
	"cost_delta_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"schedule_delta_days" integer DEFAULT 0 NOT NULL,
	"base_baseline_version" integer NOT NULL,
	"resulting_baseline_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"milestone_id" uuid,
	"uploader_user_id" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"storage_path" text,
	"mime_type" text,
	"size_bytes" bigint,
	"file_sha256" text,
	"captured_at" timestamp with time zone,
	"capture_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_target_chk" CHECK ("evidence"."task_id" is not null or "evidence"."milestone_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"stage_id" uuid,
	"assignment_id" uuid,
	"title" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"due_at" timestamp with time zone,
	"acceptance_criteria" text,
	"evidence_requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approver_user_id" uuid,
	"status" "milestone_status" DEFAULT 'pending' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_amount_chk" CHECK ("milestones"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by_change_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_baselines_uniq" UNIQUE("project_id","version")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"workmanship" smallint,
	"punctuality" smallint,
	"communication" smallint,
	"professionalism" smallint,
	"quote_accuracy" smallint,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_uniq" UNIQUE("project_id","reviewer_user_id","provider_profile_id"),
	CONSTRAINT "reviews_range_chk" CHECK (
    ("reviews"."workmanship" is null or "reviews"."workmanship" between 1 and 5) and
    ("reviews"."punctuality" is null or "reviews"."punctuality" between 1 and 5) and
    ("reviews"."communication" is null or "reviews"."communication" between 1 and 5) and
    ("reviews"."professionalism" is null or "reviews"."professionalism" between 1 and 5) and
    ("reviews"."quote_accuracy" is null or "reviews"."quote_accuracy" between 1 and 5))
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_participants_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"context_type" "conversation_context" NOT NULL,
	"context_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_context_uniq" UNIQUE("context_type","context_id")
);
--> statement-breakpoint
CREATE TABLE "message_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"target_language" text NOT NULL,
	"translated_text" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"confidence" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_translations_uniq" UNIQUE("message_id","target_language","provider")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"sender_user_id" uuid NOT NULL,
	"original_text" text NOT NULL,
	"original_language" text,
	"client_message_id" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_client_id_uniq" UNIQUE("sender_user_id","client_message_id")
);
--> statement-breakpoint
CREATE TABLE "fx_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"source_amount_minor" bigint NOT NULL,
	"source_currency" char(3) NOT NULL,
	"dest_amount_minor" bigint NOT NULL,
	"dest_currency" char(3) NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"rate_source" text NOT NULL,
	"rate_at" timestamp with time zone NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"fee_currency" char(3)
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ledger_account_kind" NOT NULL,
	"owner_key" text NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_uniq" UNIQUE("kind","owner_key","currency")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ledger_entry_kind" NOT NULL,
	"project_id" uuid,
	"milestone_id" uuid,
	"payment_id" uuid,
	"payout_id" uuid,
	"description" text,
	"idempotency_key" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "ledger_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	CONSTRAINT "ledger_lines_amount_chk" CHECK ("ledger_lines"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"milestone_id" uuid,
	"payer_user_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"state" "payment_state" DEFAULT 'created' NOT NULL,
	"provider_code" text NOT NULL,
	"method_code" text,
	"provider_reference" text,
	"released_minor" bigint DEFAULT 0 NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payments_provider_ref_uniq" UNIQUE("provider_code","provider_reference"),
	CONSTRAINT "payments_amount_chk" CHECK ("payments"."amount_minor" > 0),
	CONSTRAINT "payments_bounds_chk" CHECK ("payments"."released_minor" >= 0 and "payments"."refunded_minor" >= 0 and "payments"."released_minor" + "payments"."refunded_minor" <= "payments"."amount_minor")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"state" "payout_state" DEFAULT 'pending' NOT NULL,
	"provider_code" text NOT NULL,
	"provider_reference" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payouts_amount_chk" CHECK ("payouts"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "platform_fee_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid,
	"category_id" uuid,
	"basis_points" integer NOT NULL,
	"min_fee_minor" bigint,
	"max_fee_minor" bigint,
	"currency" char(3),
	"effective_from" date NOT NULL,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "platform_fee_rules_bps_chk" CHECK ("platform_fee_rules"."basis_points" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"event_type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" "notification_channel" DEFAULT 'in_app' NOT NULL,
	"language" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_compliance_settings" ADD CONSTRAINT "market_compliance_settings_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_currencies" ADD CONSTRAINT "market_currencies_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_currencies" ADD CONSTRAINT "market_currencies_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_holidays" ADD CONSTRAINT "market_holidays_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_languages" ADD CONSTRAINT "market_languages_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_languages" ADD CONSTRAINT "market_languages_language_code_languages_code_fk" FOREIGN KEY ("language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_payment_methods" ADD CONSTRAINT "market_payment_methods_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_service_rules" ADD CONSTRAINT "market_service_rules_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_service_rules" ADD CONSTRAINT "market_service_rules_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_tax_rules" ADD CONSTRAINT "market_tax_rules_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_verification_rules" ADD CONSTRAINT "market_verification_rules_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_parent_market_id_markets_id_fk" FOREIGN KEY ("parent_market_id") REFERENCES "public"."markets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_default_language_languages_code_fk" FOREIGN KEY ("default_language") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_default_currency_currencies_code_fk" FOREIGN KEY ("default_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_parent_id_service_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."service_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_category_synonyms" ADD CONSTRAINT "service_category_synonyms_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_category_translations" ADD CONSTRAINT "service_category_translations_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_parent_organisation_id_organisations_id_fk" FOREIGN KEY ("parent_organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_preferred_language_languages_code_fk" FOREIGN KEY ("preferred_language") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_candidates" ADD CONSTRAINT "request_candidates_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_candidates" ADD CONSTRAINT "request_candidates_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_original_language_languages_code_fk" FOREIGN KEY ("original_language") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_quote_version_id_quote_versions_id_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_request_tasks" ADD CONSTRAINT "change_request_tasks_change_request_id_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."change_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_request_tasks" ADD CONSTRAINT "change_request_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_uploader_user_id_users_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_baselines" ADD CONSTRAINT "project_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translations" ADD CONSTRAINT "message_translations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translations" ADD CONSTRAINT "message_translations_target_language_languages_code_fk" FOREIGN KEY ("target_language") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_original_language_languages_code_fk" FOREIGN KEY ("original_language") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_conversions" ADD CONSTRAINT "fx_conversions_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_conversions" ADD CONSTRAINT "fx_conversions_source_currency_currencies_code_fk" FOREIGN KEY ("source_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_conversions" ADD CONSTRAINT "fx_conversions_dest_currency_currencies_code_fk" FOREIGN KEY ("dest_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_conversions" ADD CONSTRAINT "fx_conversions_fee_currency_currencies_code_fk" FOREIGN KEY ("fee_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_entry_id_ledger_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_fee_rules" ADD CONSTRAINT "platform_fee_rules_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_fee_rules" ADD CONSTRAINT "platform_fee_rules_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_fee_rules" ADD CONSTRAINT "platform_fee_rules_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_tax_rules_market_idx" ON "market_tax_rules" USING btree ("market_id","tax_code");--> statement-breakpoint
CREATE INDEX "service_categories_parent_idx" ON "service_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "service_category_synonyms_lookup_idx" ON "service_category_synonyms" USING btree ("language_code","term");--> statement-breakpoint
CREATE INDEX "verifications_user_class_idx" ON "verifications" USING btree ("user_id","verification_class");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "requests_requester_idx" ON "requests" USING btree ("requester_user_id","status");--> statement-breakpoint
CREATE INDEX "stages_project_idx" ON "stages" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "tasks_project_status_idx" ON "tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_one_live_per_task" ON "assignments" USING btree ("task_id") WHERE "assignments"."status" in ('offered','accepted','active');--> statement-breakpoint
CREATE INDEX "assignments_provider_idx" ON "assignments" USING btree ("provider_profile_id","status");--> statement-breakpoint
CREATE INDEX "quote_line_items_version_idx" ON "quote_line_items" USING btree ("quote_version_id");--> statement-breakpoint
CREATE INDEX "quotes_project_idx" ON "quotes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "quotes_request_idx" ON "quotes" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "change_requests_project_idx" ON "change_requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "evidence_project_idx" ON "evidence" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "evidence_task_idx" ON "evidence" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "milestones_project_idx" ON "milestones" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "conversations_project_idx" ON "conversations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_project_idx" ON "ledger_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ledger_lines_entry_idx" ON "ledger_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "ledger_lines_account_idx" ON "ledger_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "payments_project_idx" ON "payments" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "activity_events_project_idx" ON "activity_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activity_events_subject_idx" ON "activity_events" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","status");