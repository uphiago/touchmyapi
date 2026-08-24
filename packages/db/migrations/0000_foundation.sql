CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('active', 'deleted', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."assessment_status" AS ENUM('draft', 'awaiting_verification', 'queued', 'running', 'analyzing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('request', 'authz', 'verify', 'policy', 'dispatch', 'runner', 'artifacts', 'analyze', 'publish', 'download', 'billing', 'delete');--> statement-breakpoint
CREATE TYPE "public"."billing_processing_status" AS ENUM('received', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."entitlement_plan" AS ENUM('free_unverified', 'free_verified', 'pro', 'lifetime');--> statement-breakpoint
CREATE TYPE "public"."entitlement_status" AS ENUM('active', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."identity_provider" AS ENUM('google', 'github', 'x');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled', 'stale_recovered');--> statement-breakpoint
CREATE TYPE "public"."report_kind" AS ENUM('pdf_technical', 'pdf_executive', 'json');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('info', 'low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."target_category" AS ENUM('web', 'api', 'surface', 'genai', 'internal');--> statement-breakpoint
CREATE TYPE "public"."verification_method" AS ENUM('http_file', 'dns_txt');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'verified', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE "assessment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"target_category" "target_category" NOT NULL,
	"target_json" jsonb NOT NULL,
	"scope_json" jsonb NOT NULL,
	"playbook_id" text NOT NULL,
	"playbook_version" text NOT NULL,
	"limits_json" jsonb NOT NULL,
	"status" "assessment_status" DEFAULT 'draft' NOT NULL,
	"failure_reason" text,
	"verification_ref" uuid,
	"credits_estimate" integer DEFAULT 0 NOT NULL,
	"credits_consumed" integer DEFAULT 0 NOT NULL,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_account_id_id_unique" UNIQUE("account_id","id"),
	CONSTRAINT "assessment_credits_estimate_nonnegative" CHECK ("assessment"."credits_estimate" >= 0),
	CONSTRAINT "assessment_credits_consumed_nonnegative" CHECK ("assessment"."credits_consumed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "authorization_attestation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"target_json" jsonb NOT NULL,
	"terms_version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorization_attestation_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"assessment_id" uuid,
	"job_id" uuid,
	"actor" text NOT NULL,
	"action" "audit_action" NOT NULL,
	"prev_event_id" uuid,
	"payload_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_event_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"assessment_id" uuid,
	"kind" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "billing_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload_minimal_json" jsonb NOT NULL,
	"signature_valid" boolean DEFAULT false NOT NULL,
	"event_version" text NOT NULL,
	"api_version" text,
	"processing_status" "billing_processing_status" DEFAULT 'received' NOT NULL,
	"result_json" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "billing_event_stripe_event_id_unique" UNIQUE("stripe_event_id"),
	CONSTRAINT "billing_event_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"encrypted_payload" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"purpose" text NOT NULL,
	"retained_for_schedule" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "credential_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "credit_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"assessment_id" uuid,
	"credits" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_entry_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "entitlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"plan" "entitlement_plan" NOT NULL,
	"status" "entitlement_status" DEFAULT 'active' NOT NULL,
	"source_event_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "entitlement_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "playbook" (
	"key" text NOT NULL,
	"playbook_version" text NOT NULL,
	"target_category" "target_category" NOT NULL,
	"contract_json" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "playbook_pk" PRIMARY KEY("key","playbook_version")
);
--> statement-breakpoint
CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "agent_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"playbook_version" text NOT NULL,
	"job_spec_json" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"dedupe_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"stop_requested_at" timestamp with time zone,
	CONSTRAINT "job_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "job_account_id_id_unique" UNIQUE("account_id","id"),
	CONSTRAINT "job_attempts_nonnegative" CHECK ("job"."attempts" >= 0),
	CONSTRAINT "job_max_attempts_positive" CHECK ("job"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "runner_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"sandbox_impl" text NOT NULL,
	"container_id" text,
	"image_digest" text,
	"limits_used_json" jsonb,
	"artifact_manifest_json" jsonb,
	"output_manifest_json" jsonb,
	"cleaned_up" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runner_execution_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"settings_ia_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "account_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "session_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"provider_subject" text NOT NULL,
	"email" "citext",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_provider_subject_unique" UNIQUE("provider","provider_subject"),
	CONSTRAINT "user_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "user_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"target_json" jsonb NOT NULL,
	"method" "verification_method" DEFAULT 'http_file' NOT NULL,
	"challenge_token" text NOT NULL,
	"challenge_host" text,
	"status" "verification_status" DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"fetch_evidence" jsonb,
	CONSTRAINT "verification_account_id_id_unique" UNIQUE("account_id","id"),
	CONSTRAINT "verification_challenge_token_unique" UNIQUE("challenge_token")
);
--> statement-breakpoint
CREATE TABLE "finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"severity" "severity" NOT NULL,
	"endpoint" text,
	"evidence_json" jsonb,
	"repro" text,
	"impact" text,
	"remediation" text,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"kind" "report_kind" NOT NULL,
	"object_key" text NOT NULL,
	"contract_version" text NOT NULL,
	"sanitized" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_account_id_id_unique" UNIQUE("account_id","id")
);
--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_verification_fk" FOREIGN KEY ("account_id","verification_ref") REFERENCES "public"."verification"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_agent_fk" FOREIGN KEY ("account_id","agent_id") REFERENCES "public"."agent"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_playbook_fk" FOREIGN KEY ("playbook_id","playbook_version") REFERENCES "public"."playbook"("key","playbook_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_attestation" ADD CONSTRAINT "authorization_attestation_assessment_fk" FOREIGN KEY ("account_id","assessment_id") REFERENCES "public"."assessment"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_attestation" ADD CONSTRAINT "authorization_attestation_user_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."user"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_assessment_fk" FOREIGN KEY ("account_id","assessment_id") REFERENCES "public"."assessment"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_job_fk" FOREIGN KEY ("account_id","job_id") REFERENCES "public"."job"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_prev_fk" FOREIGN KEY ("account_id","prev_event_id") REFERENCES "public"."audit_event"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_assessment_fk" FOREIGN KEY ("account_id","assessment_id") REFERENCES "public"."assessment"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_event" ADD CONSTRAINT "billing_event_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_assessment_fk" FOREIGN KEY ("account_id","assessment_id") REFERENCES "public"."assessment"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_assessment_fk" FOREIGN KEY ("account_id","assessment_id") REFERENCES "public"."assessment"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_source_event_fk" FOREIGN KEY ("account_id","source_event_id") REFERENCES "public"."billing_event"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_assessment_fk" FOREIGN KEY ("account_id","assessment_id") REFERENCES "public"."assessment"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_execution" ADD CONSTRAINT "runner_execution_job_fk" FOREIGN KEY ("account_id","job_id") REFERENCES "public"."job"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_account_user_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."user"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification" ADD CONSTRAINT "verification_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_assessment_fk" FOREIGN KEY ("account_id","assessment_id") REFERENCES "public"."assessment"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_assessment_fk" FOREIGN KEY ("account_id","assessment_id") REFERENCES "public"."assessment"("account_id","id") ON DELETE no action ON UPDATE no action;
