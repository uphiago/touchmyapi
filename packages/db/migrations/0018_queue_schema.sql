CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid,
	"schema_version" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"fencing_token" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"last_error" text,
	"failed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "outbox_event_account_id_id_unique" UNIQUE("account_id","id"),
	CONSTRAINT "outbox_event_attempts_nonnegative" CHECK ("outbox_event"."attempts" >= 0),
	CONSTRAINT "outbox_event_max_attempts_positive" CHECK ("outbox_event"."max_attempts" > 0),
	CONSTRAINT "outbox_event_fencing_nonnegative" CHECK ("outbox_event"."fencing_token" >= 0)
);
--> statement-breakpoint
CREATE TABLE "queue_global_state" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"running_count" integer DEFAULT 0 NOT NULL,
	"concurrency_limit" integer DEFAULT 8 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_global_state_id_global" CHECK ("queue_global_state"."id" = 'global'),
	CONSTRAINT "queue_global_state_running_nonnegative" CHECK ("queue_global_state"."running_count" >= 0),
	CONSTRAINT "queue_global_state_limit_positive" CHECK ("queue_global_state"."concurrency_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "queue_tenant_state" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"last_dispatched_at" timestamp with time zone,
	"running_count" integer DEFAULT 0 NOT NULL,
	"concurrency_limit" integer DEFAULT 2 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_tenant_state_running_nonnegative" CHECK ("queue_tenant_state"."running_count" >= 0),
	CONSTRAINT "queue_tenant_state_limit_positive" CHECK ("queue_tenant_state"."concurrency_limit" > 0)
);
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "normalized_target_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "fencing_token" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_tenant_state" ADD CONSTRAINT "queue_tenant_state_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_event_claim_idx" ON "outbox_event" USING btree ("available_at","account_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_active_target_unique" ON "job" USING btree ("account_id","normalized_target_key") WHERE "job"."status" in ('queued', 'stale_recovered', 'running');--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_fencing_nonnegative" CHECK ("job"."fencing_token" >= 0);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'queue_control') THEN
    CREATE ROLE queue_control NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'queue_connector') THEN
    CREATE ROLE queue_connector LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_queue_connector') THEN
    CREATE ROLE admin_queue_connector LOGIN NOINHERIT;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS app_private;
GRANT USAGE ON SCHEMA public, app_private TO queue_control;

INSERT INTO public.queue_global_state (id, running_count, concurrency_limit)
VALUES ('global', 0, 8)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.queue_tenant_state (account_id, running_count, concurrency_limit)
SELECT a.id, 0, 2
FROM public.account AS a
WHERE a.status = 'active'::public.account_status
  AND a.deleted_at IS NULL
ON CONFLICT (account_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app_private.queue_account_state_on_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
BEGIN
  INSERT INTO public.queue_tenant_state (account_id, running_count, concurrency_limit)
  VALUES (NEW.id, 0, 2)
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
END;
$$;
ALTER FUNCTION app_private.queue_account_state_on_account() OWNER TO queue_control;
DROP TRIGGER IF EXISTS account_queue_state_after_insert ON public.account;
CREATE TRIGGER account_queue_state_after_insert
  AFTER INSERT ON public.account
  FOR EACH ROW EXECUTE FUNCTION app_private.queue_account_state_on_account();

ALTER TABLE public.queue_global_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_global_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.queue_tenant_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_tenant_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS queue_global_state_control ON public.queue_global_state;
CREATE POLICY queue_global_state_control
  ON public.queue_global_state FOR ALL TO queue_control
  USING (id = 'global') WITH CHECK (id = 'global');
DROP POLICY IF EXISTS queue_tenant_state_control ON public.queue_tenant_state;
CREATE POLICY queue_tenant_state_control
  ON public.queue_tenant_state FOR ALL TO queue_control
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS outbox_event_control ON public.outbox_event;
CREATE POLICY outbox_event_control
  ON public.outbox_event FOR ALL TO queue_control
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.queue_global_state, public.queue_tenant_state, public.outbox_event
  FROM PUBLIC, api_rls, worker_rls, reporting_rls, queue_connector, admin_queue_connector;
GRANT ALL ON TABLE public.queue_global_state, public.queue_tenant_state, public.outbox_event
  TO queue_control;

CREATE OR REPLACE FUNCTION app_private.queue_unavailable()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
BEGIN
  RAISE EXCEPTION 'queue function unavailable' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION app_private.queue_enqueue(uuid, uuid, timestamptz, integer, integer)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION app_private.queue_claim(text, integer, timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION app_private.queue_heartbeat(uuid, uuid, text, bigint, integer, timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION app_private.queue_complete(uuid, uuid, text, bigint, jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION app_private.queue_fail(uuid, uuid, text, bigint, text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION app_private.queue_reap(integer, timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN 0; END $$;
CREATE OR REPLACE FUNCTION app_private.queue_reconcile(integer, timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN 0; END $$;
CREATE OR REPLACE FUNCTION app_private.outbox_claim(text, integer, timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION app_private.outbox_heartbeat(uuid, uuid, text, bigint, timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION app_private.outbox_ack(uuid, uuid, text, bigint, timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN false; END $$;
CREATE OR REPLACE FUNCTION app_private.outbox_fail(uuid, uuid, text, bigint, text, timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN false; END $$;
CREATE OR REPLACE FUNCTION app_private.outbox_reap(integer, timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app_private
AS $$ BEGIN PERFORM app_private.queue_unavailable(); RETURN 0; END $$;

REVOKE ALL ON FUNCTION app_private.queue_unavailable() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.queue_enqueue(uuid, uuid, timestamptz, integer, integer) FROM PUBLIC, queue_connector, admin_queue_connector;
GRANT EXECUTE ON FUNCTION app_private.queue_enqueue(uuid, uuid, timestamptz, integer, integer) TO api_rls;
REVOKE ALL ON FUNCTION app_private.queue_claim(text, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.queue_heartbeat(uuid, uuid, text, bigint, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.queue_complete(uuid, uuid, text, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.queue_fail(uuid, uuid, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.queue_reap(integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.queue_reconcile(integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.outbox_claim(text, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.outbox_heartbeat(uuid, uuid, text, bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.outbox_ack(uuid, uuid, text, bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.outbox_fail(uuid, uuid, text, bigint, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.outbox_reap(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.queue_claim(text, integer, timestamptz),
  app_private.queue_heartbeat(uuid, uuid, text, bigint, integer, timestamptz),
  app_private.queue_complete(uuid, uuid, text, bigint, jsonb),
  app_private.queue_fail(uuid, uuid, text, bigint, text),
  app_private.queue_reap(integer, timestamptz),
  app_private.queue_reconcile(integer, timestamptz),
  app_private.outbox_claim(text, integer, timestamptz),
  app_private.outbox_heartbeat(uuid, uuid, text, bigint, timestamptz),
  app_private.outbox_ack(uuid, uuid, text, bigint, timestamptz),
  app_private.outbox_fail(uuid, uuid, text, bigint, text, timestamptz),
  app_private.outbox_reap(integer, timestamptz)
  TO queue_connector;
ALTER FUNCTION app_private.queue_unavailable() OWNER TO queue_control;
ALTER FUNCTION app_private.queue_enqueue(uuid, uuid, timestamptz, integer, integer) OWNER TO queue_control;
ALTER FUNCTION app_private.queue_claim(text, integer, timestamptz) OWNER TO queue_control;
ALTER FUNCTION app_private.queue_heartbeat(uuid, uuid, text, bigint, integer, timestamptz) OWNER TO queue_control;
ALTER FUNCTION app_private.queue_complete(uuid, uuid, text, bigint, jsonb) OWNER TO queue_control;
ALTER FUNCTION app_private.queue_fail(uuid, uuid, text, bigint, text) OWNER TO queue_control;
ALTER FUNCTION app_private.queue_reap(integer, timestamptz) OWNER TO queue_control;
ALTER FUNCTION app_private.queue_reconcile(integer, timestamptz) OWNER TO queue_control;
ALTER FUNCTION app_private.outbox_claim(text, integer, timestamptz) OWNER TO queue_control;
ALTER FUNCTION app_private.outbox_heartbeat(uuid, uuid, text, bigint, timestamptz) OWNER TO queue_control;
ALTER FUNCTION app_private.outbox_ack(uuid, uuid, text, bigint, timestamptz) OWNER TO queue_control;
ALTER FUNCTION app_private.outbox_fail(uuid, uuid, text, bigint, text, timestamptz) OWNER TO queue_control;
ALTER FUNCTION app_private.outbox_reap(integer, timestamptz) OWNER TO queue_control;
