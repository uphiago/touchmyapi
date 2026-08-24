-- Keep runtime audit writers on the fixed insert shape.  In particular,
-- chain_seq is database-assigned and cannot be supplied by a connector.
REVOKE INSERT ON TABLE public.audit_event FROM api_rls, worker_rls, audit_system, auth_bootstrap;
GRANT INSERT (
  id,
  account_id,
  assessment_id,
  job_id,
  actor,
  action,
  prev_event_id,
  payload_json
) ON TABLE public.audit_event TO api_rls, worker_rls, audit_system;

-- nextval requires USAGE, while SELECT would expose the sequence as a raw
-- ordering oracle/API.  Keep the runtime roles unable to read it directly.
REVOKE SELECT ON SEQUENCE public.audit_event_chain_seq FROM api_rls, worker_rls, audit_system;
GRANT USAGE ON SEQUENCE public.audit_event_chain_seq TO api_rls, worker_rls, audit_system;

DO $$
DECLARE
  migration_owner oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF (SELECT c.relowner FROM pg_class AS c WHERE c.oid = 'public.audit_event'::regclass)
      IS DISTINCT FROM migration_owner
     OR (SELECT c.relowner FROM pg_class AS c WHERE c.oid = 'public.audit_event_chain_seq'::regclass)
      IS DISTINCT FROM migration_owner THEN
    RAISE EXCEPTION 'migration owner % does not own audit insert-boundary objects', current_user;
  END IF;
END;
$$;
