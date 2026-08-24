ALTER TABLE public.finding
  ADD COLUMN source_key text DEFAULT ('legacy:' || gen_random_uuid()::text) NOT NULL;
ALTER TABLE public.notification
  ADD COLUMN event_key text DEFAULT ('legacy:' || gen_random_uuid()::text) NOT NULL;
ALTER TABLE public.runner_execution
  ADD COLUMN fencing_token integer DEFAULT 0 NOT NULL;

ALTER TABLE public.finding
  ADD CONSTRAINT finding_source_key_bounded
  CHECK (length(source_key) BETWEEN 1 AND 255);
ALTER TABLE public.notification
  ADD CONSTRAINT notification_event_key_bounded
  CHECK (length(event_key) BETWEEN 1 AND 255);
ALTER TABLE public.runner_execution
  ADD CONSTRAINT runner_execution_fencing_nonnegative
  CHECK (fencing_token >= 0);

ALTER TABLE public.finding
  ADD CONSTRAINT finding_assessment_source_unique
  UNIQUE (account_id, assessment_id, source_key);
ALTER TABLE public.notification
  ADD CONSTRAINT notification_account_event_unique
  UNIQUE (account_id, event_key);
ALTER TABLE public.runner_execution
  ADD CONSTRAINT runner_execution_job_fence_unique
  UNIQUE (account_id, job_id, fencing_token);
ALTER TABLE public.report
  ADD CONSTRAINT report_assessment_kind_unique
  UNIQUE (account_id, assessment_id, kind);

CREATE OR REPLACE FUNCTION app_private.queue_assessment_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'running'::public.job_status THEN
    UPDATE public.assessment
    SET status = 'running'::public.assessment_status,
        updated_at = clock_timestamp()
    WHERE id = NEW.assessment_id AND account_id = NEW.account_id
      AND status IN ('queued'::public.assessment_status, 'running'::public.assessment_status);
  ELSIF NEW.status = 'stale_recovered'::public.job_status THEN
    UPDATE public.assessment
    SET status = 'queued'::public.assessment_status,
        updated_at = clock_timestamp()
    WHERE id = NEW.assessment_id AND account_id = NEW.account_id
      AND status IN ('running'::public.assessment_status, 'queued'::public.assessment_status);
  ELSIF NEW.status = 'succeeded'::public.job_status THEN
    UPDATE public.assessment
    SET status = 'analyzing'::public.assessment_status,
        updated_at = clock_timestamp()
    WHERE id = NEW.assessment_id AND account_id = NEW.account_id
      AND status IN ('running'::public.assessment_status, 'analyzing'::public.assessment_status);

    INSERT INTO public.outbox_event (
      id, account_id, event_key, aggregate_type, aggregate_id, schema_version,
      payload_json, status, attempts, max_attempts, available_at, fencing_token,
      created_at
    ) VALUES (
      gen_random_uuid(), NEW.account_id,
      'job:' || NEW.id::text || ':delivery:' || NEW.fencing_token::text,
      'job_delivery', NEW.id, 'job.delivery@1',
      jsonb_build_object(
        'event', 'job_succeeded',
        'jobId', NEW.id,
        'fencingToken', NEW.fencing_token
      ),
      'pending'::public.outbox_status, 0, 5, clock_timestamp(), 0,
      clock_timestamp()
    ) ON CONFLICT (event_key) DO NOTHING;
  ELSIF NEW.status IN ('failed'::public.job_status, 'cancelled'::public.job_status) THEN
    UPDATE public.assessment
    SET status = CASE
          WHEN NEW.status = 'cancelled'::public.job_status
            THEN 'cancelled'::public.assessment_status
          ELSE 'failed'::public.assessment_status
        END,
        failure_reason = CASE
          WHEN NEW.status = 'failed'::public.job_status THEN NEW.failure_reason
          ELSE failure_reason
        END,
        updated_at = clock_timestamp()
    WHERE id = NEW.assessment_id AND account_id = NEW.account_id
      AND status NOT IN (
        'completed'::public.assessment_status,
        'cancelled'::public.assessment_status
      );

    INSERT INTO public.outbox_event (
      id, account_id, event_key, aggregate_type, aggregate_id, schema_version,
      payload_json, status, attempts, max_attempts, available_at, fencing_token,
      created_at
    ) VALUES (
      gen_random_uuid(), NEW.account_id,
      'job:' || NEW.id::text || ':terminal:' || NEW.fencing_token::text,
      'job_delivery', NEW.id, 'job.delivery@1',
      jsonb_build_object(
        'event', CASE
          WHEN NEW.status = 'cancelled'::public.job_status THEN 'job_cancelled'
          ELSE 'job_failed'
        END,
        'jobId', NEW.id,
        'fencingToken', NEW.fencing_token
      ),
      'pending'::public.outbox_status, 0, 5, clock_timestamp(), 0,
      clock_timestamp()
    ) ON CONFLICT (event_key) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION app_private.queue_assessment_transition() OWNER TO queue_control;
REVOKE ALL ON FUNCTION app_private.queue_assessment_transition() FROM PUBLIC;
DROP TRIGGER IF EXISTS job_assessment_transition_after_update ON public.job;
CREATE TRIGGER job_assessment_transition_after_update
  AFTER UPDATE OF status ON public.job
  FOR EACH ROW EXECUTE FUNCTION app_private.queue_assessment_transition();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worker_connector') THEN
    CREATE ROLE worker_connector LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
      NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_connector') THEN
    CREATE ROLE reporting_connector LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
      NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

ALTER ROLE worker_connector LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
  NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE reporting_connector LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
  NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT member.rolname AS member_name, parent.rolname AS parent_name
    FROM pg_auth_members relation
    JOIN pg_roles parent ON parent.oid = relation.roleid
    JOIN pg_roles member ON member.oid = relation.member
    WHERE member.rolname IN ('worker_connector', 'reporting_connector')
      AND NOT (
        (member.rolname = 'worker_connector' AND parent.rolname = 'worker_rls')
        OR (member.rolname = 'reporting_connector' AND parent.rolname = 'reporting_rls')
      )
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.parent_name, membership.member_name);
  END LOOP;
END
$$;

GRANT worker_rls TO worker_connector;
GRANT reporting_rls TO reporting_connector;
REVOKE CREATE ON SCHEMA public FROM worker_connector, reporting_connector;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM worker_connector, reporting_connector;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM worker_connector, reporting_connector;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM worker_connector, reporting_connector;
