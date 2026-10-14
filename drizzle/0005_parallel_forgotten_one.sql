CREATE TABLE "provider_payout_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"currency" char(3) NOT NULL,
	"bank_code" text NOT NULL,
	"account_last4" text NOT NULL,
	"account_name" text NOT NULL,
	"recipient_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_payout_accounts_provider_profile_id_unique" UNIQUE("provider_profile_id"),
	CONSTRAINT "payout_accounts_last4_chk" CHECK (char_length("provider_payout_accounts"."account_last4") = 4)
);
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_payout_accounts" ADD CONSTRAINT "provider_payout_accounts_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_payout_accounts" ADD CONSTRAINT "provider_payout_accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payouts_provider_idx" ON "payouts" USING btree ("provider_profile_id","state");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_provider_ref_uniq" UNIQUE("provider_code","provider_reference");