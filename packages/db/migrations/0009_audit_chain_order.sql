-- Monotonic append order and the bootstrap-owner policy boundary.
CREATE SEQUENCE IF NOT EXISTS public.audit_event_chain_seq AS bigint;
ALTER TABLE public.audit_event ADD COLUMN IF NOT EXISTS chain_seq bigint;

WITH ordered AS (
  SELECT id, nextval('public.audit_event_chain_seq') AS chain_seq
  FROM public.audit_event
  WHERE chain_seq IS NULL
  ORDER BY account_id NULLS FIRST, created_at, id
)
UPDATE public.audit_event AS event
SET chain_seq = ordered.chain_seq
FROM ordered
WHERE event.id = ordered.id;

ALTER TABLE public.audit_event
  ALTER COLUMN chain_seq SET DEFAULT nextval('public.audit_event_chain_seq'),
  ALTER COLUMN chain_seq SET NOT NULL;
ALTER SEQUENCE public.audit_event_chain_seq OWNED BY public.audit_event.chain_seq;
GRANT USAGE, SELECT ON SEQUENCE public.audit_event_chain_seq TO api_rls, worker_rls, audit_system;

-- SECURITY DEFINER auth bootstrap runs as the migration owner.  Keep the
-- bootstrap predicate narrow while allowing that owner to pass FORCE RLS;
-- runtime/system roles are not included and cannot evaluate this predicate.
DO $$
DECLARE
  owner_name text := current_user;
BEGIN
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.rls_bootstrap_context() TO %I',
    owner_name
  );
  DROP POLICY IF EXISTS audit_event_bootstrap ON public.audit_event;
  EXECUTE format(
    'CREATE POLICY audit_event_bootstrap ON public.audit_event FOR ALL TO auth_bootstrap, %I USING (public.rls_bootstrap_context()) WITH CHECK (public.rls_bootstrap_context())',
    owner_name
  );
  DROP POLICY IF EXISTS audit_account_state_bootstrap ON public.audit_account_state;
  EXECUTE format(
    'CREATE POLICY audit_account_state_bootstrap ON public.audit_account_state FOR ALL TO auth_bootstrap, %I USING (public.rls_bootstrap_context()) WITH CHECK (public.rls_bootstrap_context())',
    owner_name
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_complete_google_login(
  p_provider_subject text,
  login_email citext,
  session_hash text,
  session_expires_at timestamptz,
  client_ip inet,
  client_user_agent text
)
RETURNS TABLE (account_id uuid, user_id uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  found_account_id uuid;
  found_user_id uuid;
  found_account_status public.account_status;
  found_deleted_at timestamptz;
  previous_event_id uuid;
BEGIN
  IF p_provider_subject IS NULL OR btrim(p_provider_subject) = ''
     OR session_hash IS NULL OR session_hash !~ '^[0-9a-f]{64}$'
     OR session_expires_at IS NULL OR session_expires_at <= clock_timestamp()
     OR session_expires_at > clock_timestamp() + interval '31 days' THEN
    RETURN;
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_subject, 0));
  SELECT u.account_id, u.id, a.status, a.deleted_at
  INTO found_account_id, found_user_id, found_account_status, found_deleted_at
  FROM public."user" AS u
  JOIN public.account AS a ON a.id = u.account_id
  WHERE u.provider = 'google'::public.identity_provider
    AND u.provider_subject = p_provider_subject
  FOR UPDATE OF u, a;
  IF found_user_id IS NOT NULL THEN
    IF found_account_status <> 'active'::public.account_status OR found_deleted_at IS NOT NULL THEN
      RETURN;
    END IF;
    UPDATE public."user" SET email = login_email WHERE id = found_user_id;
  ELSE
    INSERT INTO public.account (status, settings_ia_enabled)
    VALUES ('active'::public.account_status, true)
    RETURNING id INTO found_account_id;
    INSERT INTO public.audit_account_state (account_id) VALUES (found_account_id);
    INSERT INTO public."user" (account_id, provider, provider_subject, email)
    VALUES (found_account_id, 'google'::public.identity_provider, p_provider_subject, login_email)
    RETURNING id INTO found_user_id;
  END IF;
  INSERT INTO public.session (account_id, user_id, token_hash, expires_at, ip, user_agent)
  VALUES (found_account_id, found_user_id, session_hash, session_expires_at, client_ip, client_user_agent)
  RETURNING id INTO session_id;

  -- Login audit and tenant writers share the same dedicated serialization row.
  PERFORM 1
  FROM public.audit_account_state AS state
  WHERE state.account_id = found_account_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit account state unavailable';
  END IF;
  SELECT id INTO previous_event_id
  FROM public.audit_event AS event
  WHERE event.account_id = found_account_id
  ORDER BY event.chain_seq DESC
  LIMIT 1;
  INSERT INTO public.audit_event (account_id, actor, action, prev_event_id, payload_json)
  VALUES (found_account_id, 'google_oauth', 'authz'::public.audit_action, previous_event_id, '{"provider":"google","event":"login"}'::jsonb);
  account_id := found_account_id;
  user_id := found_user_id;
  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.auth_complete_google_login(text, citext, text, timestamptz, inet, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_complete_google_login(text, citext, text, timestamptz, inet, text) TO auth_bootstrap;
ALTER FUNCTION public.auth_complete_google_login(text, citext, text, timestamptz, inet, text) OWNER TO CURRENT_USER;

DO $$
DECLARE
  migration_owner oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF (SELECT c.relowner FROM pg_class AS c WHERE c.oid = 'public.audit_event'::regclass)
      IS DISTINCT FROM migration_owner
     OR (SELECT c.relowner FROM pg_class AS c WHERE c.oid = 'public.audit_account_state'::regclass)
      IS DISTINCT FROM migration_owner
     OR (SELECT c.relowner FROM pg_class AS c WHERE c.oid = 'public.audit_event_chain_seq'::regclass)
      IS DISTINCT FROM migration_owner THEN
    RAISE EXCEPTION 'migration owner % does not own audit chain objects', current_user;
  END IF;
END;
$$;
