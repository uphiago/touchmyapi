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

DROP POLICY IF EXISTS job_queue_control ON public.job;
CREATE POLICY job_queue_control
  ON public.job FOR ALL TO queue_control
  USING (true) WITH CHECK (true);
GRANT SELECT (
  id, account_id, status, available_at, priority, attempts, max_attempts,
  lease_owner, lease_expires_at, fencing_token, started_at, stop_requested_at,
  failure_reason, created_at, normalized_target_key
) ON public.job TO queue_control;
GRANT UPDATE (
  status, available_at, attempts, lease_owner, lease_expires_at, fencing_token,
  started_at, finished_at, stop_requested_at, failure_reason
) ON public.job TO queue_control;

CREATE OR REPLACE FUNCTION app_private.queue_claim(
  p_worker_id text,
  p_lease_seconds integer,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  global_running integer;
  global_limit integer;
  selected_account_id uuid;
  selected_job_id uuid;
  selected_fence integer;
  lease_until timestamptz;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 900
     OR p_now IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT running_count, concurrency_limit
  INTO global_running, global_limit
  FROM public.queue_global_state
  WHERE id = 'global'
  FOR UPDATE;
  IF global_running IS NULL OR global_limit IS NULL OR global_running >= global_limit THEN
    RETURN NULL;
  END IF;

  SELECT state.account_id
  INTO selected_account_id
  FROM public.queue_tenant_state AS state
  WHERE state.running_count < state.concurrency_limit
    AND EXISTS (
      SELECT 1
      FROM public.job AS candidate
      WHERE candidate.account_id = state.account_id
        AND candidate.status IN ('queued'::public.job_status, 'stale_recovered'::public.job_status)
        AND candidate.available_at <= p_now
    )
  ORDER BY state.last_dispatched_at NULLS FIRST, state.account_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF selected_account_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT candidate.id
  INTO selected_job_id
  FROM public.job AS candidate
  WHERE candidate.account_id = selected_account_id
    AND candidate.status IN ('queued'::public.job_status, 'stale_recovered'::public.job_status)
    AND candidate.available_at <= p_now
  ORDER BY candidate.priority DESC, candidate.available_at, candidate.created_at, candidate.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF selected_job_id IS NULL THEN
    RETURN NULL;
  END IF;

  lease_until := p_now + make_interval(secs => p_lease_seconds);
  UPDATE public.job
  SET status = 'running'::public.job_status,
      lease_owner = p_worker_id,
      lease_expires_at = lease_until,
      started_at = COALESCE(started_at, p_now),
      fencing_token = fencing_token + 1
  WHERE id = selected_job_id
  RETURNING fencing_token INTO selected_fence;

  UPDATE public.queue_tenant_state
  SET running_count = running_count + 1,
      last_dispatched_at = p_now,
      updated_at = p_now
  WHERE account_id = selected_account_id;
  UPDATE public.queue_global_state
  SET running_count = running_count + 1,
      updated_at = p_now
  WHERE id = 'global';

  RETURN jsonb_build_object(
    'jobId', selected_job_id,
    'accountId', selected_account_id,
    'status', 'running',
    'leaseOwner', p_worker_id,
    'leaseExpiresAt', lease_until,
    'fencingToken', selected_fence
  );
END;
$$;
ALTER FUNCTION app_private.queue_claim(text, integer, timestamptz) OWNER TO queue_control;
REVOKE ALL ON FUNCTION app_private.queue_claim(text, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.queue_claim(text, integer, timestamptz) TO queue_connector;

CREATE OR REPLACE FUNCTION app_private.queue_heartbeat(
  p_account_id uuid,
  p_job_id uuid,
  p_lease_owner text,
  p_fencing_token bigint,
  p_lease_seconds integer,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  ignored integer;
  renewed_until timestamptz;
BEGIN
  IF p_account_id IS NULL OR p_job_id IS NULL OR p_lease_owner IS NULL
     OR p_lease_owner !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR p_fencing_token IS NULL OR p_lease_seconds IS NULL
     OR p_lease_seconds < 1 OR p_lease_seconds > 900 OR p_now IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM public.queue_global_state WHERE id = 'global' FOR UPDATE;
  PERFORM 1 FROM public.queue_tenant_state
  WHERE account_id = p_account_id
  FOR UPDATE;
  SELECT 1 INTO ignored
  FROM public.job
  WHERE id = p_job_id AND account_id = p_account_id
    AND status = 'running'::public.job_status
    AND lease_owner = p_lease_owner
    AND fencing_token = p_fencing_token
    AND lease_expires_at > p_now
  FOR UPDATE;
  IF ignored IS NULL THEN RETURN NULL; END IF;
  renewed_until := p_now + make_interval(secs => p_lease_seconds);
  UPDATE public.job
  SET lease_expires_at = renewed_until
  WHERE id = p_job_id AND account_id = p_account_id;
  RETURN jsonb_build_object(
    'jobId', p_job_id, 'accountId', p_account_id,
    'status', 'running', 'leaseOwner', p_lease_owner,
    'leaseExpiresAt', renewed_until, 'fencingToken', p_fencing_token
  );
END;
$$;

CREATE OR REPLACE FUNCTION app_private.queue_complete(
  p_account_id uuid,
  p_job_id uuid,
  p_lease_owner text,
  p_fencing_token bigint,
  p_result_metadata jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  ignored integer;
BEGIN
  IF p_account_id IS NULL OR p_job_id IS NULL OR p_lease_owner IS NULL
     OR p_lease_owner !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR p_fencing_token IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM public.queue_global_state WHERE id = 'global' FOR UPDATE;
  PERFORM 1 FROM public.queue_tenant_state
  WHERE account_id = p_account_id
  FOR UPDATE;
  SELECT 1 INTO ignored
  FROM public.job
  WHERE id = p_job_id AND account_id = p_account_id
    AND status = 'running'::public.job_status
    AND lease_owner = p_lease_owner
    AND fencing_token = p_fencing_token
  FOR UPDATE;
  IF ignored IS NULL THEN RETURN NULL; END IF;
  UPDATE public.job
  SET status = 'succeeded'::public.job_status,
      lease_owner = NULL, lease_expires_at = NULL, finished_at = clock_timestamp()
  WHERE id = p_job_id AND account_id = p_account_id;
  UPDATE public.queue_tenant_state
  SET running_count = GREATEST(running_count - 1, 0), updated_at = clock_timestamp()
  WHERE account_id = p_account_id;
  UPDATE public.queue_global_state
  SET running_count = GREATEST(running_count - 1, 0), updated_at = clock_timestamp()
  WHERE id = 'global';
  RETURN jsonb_build_object(
    'jobId', p_job_id, 'accountId', p_account_id,
    'status', 'succeeded', 'fencingToken', p_fencing_token
  );
END;
$$;

CREATE OR REPLACE FUNCTION app_private.queue_fail(
  p_account_id uuid,
  p_job_id uuid,
  p_lease_owner text,
  p_fencing_token bigint,
  p_failure_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  ignored integer;
  safe_reason text;
BEGIN
  IF p_account_id IS NULL OR p_job_id IS NULL OR p_lease_owner IS NULL
     OR p_lease_owner !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR p_fencing_token IS NULL OR p_failure_reason IS NULL
     OR length(p_failure_reason) > 512 OR p_failure_reason ~ '[\r\n]' THEN
    RETURN NULL;
  END IF;
  safe_reason := btrim(p_failure_reason);
  IF safe_reason = '' THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.queue_global_state WHERE id = 'global' FOR UPDATE;
  PERFORM 1 FROM public.queue_tenant_state
  WHERE account_id = p_account_id
  FOR UPDATE;
  SELECT 1 INTO ignored
  FROM public.job
  WHERE id = p_job_id AND account_id = p_account_id
    AND status = 'running'::public.job_status
    AND lease_owner = p_lease_owner
    AND fencing_token = p_fencing_token
  FOR UPDATE;
  IF ignored IS NULL THEN RETURN NULL; END IF;
  UPDATE public.job
  SET status = 'failed'::public.job_status,
      lease_owner = NULL, lease_expires_at = NULL, finished_at = clock_timestamp(),
      attempts = attempts + 1, failure_reason = safe_reason
  WHERE id = p_job_id AND account_id = p_account_id;
  UPDATE public.queue_tenant_state
  SET running_count = GREATEST(running_count - 1, 0), updated_at = clock_timestamp()
  WHERE account_id = p_account_id;
  UPDATE public.queue_global_state
  SET running_count = GREATEST(running_count - 1, 0), updated_at = clock_timestamp()
  WHERE id = 'global';
  RETURN jsonb_build_object(
    'jobId', p_job_id, 'accountId', p_account_id,
    'status', 'failed', 'fencingToken', p_fencing_token
  );
END;
$$;

ALTER FUNCTION app_private.queue_heartbeat(uuid, uuid, text, bigint, integer, timestamptz) OWNER TO queue_control;
ALTER FUNCTION app_private.queue_complete(uuid, uuid, text, bigint, jsonb) OWNER TO queue_control;
ALTER FUNCTION app_private.queue_fail(uuid, uuid, text, bigint, text) OWNER TO queue_control;
REVOKE ALL ON FUNCTION app_private.queue_heartbeat(uuid, uuid, text, bigint, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.queue_complete(uuid, uuid, text, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.queue_fail(uuid, uuid, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.queue_heartbeat(uuid, uuid, text, bigint, integer, timestamptz),
  app_private.queue_complete(uuid, uuid, text, bigint, jsonb),
  app_private.queue_fail(uuid, uuid, text, bigint, text)
  TO queue_connector;
