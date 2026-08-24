-- Dedicated per-account serialization authority for tenant audit chains.
-- The row has no mutable operational fields: UPDATE is granted only because
-- PostgreSQL requires it for SELECT ... FOR UPDATE under FORCE RLS.
CREATE TABLE public.audit_account_state (
  account_id uuid PRIMARY KEY,
  CONSTRAINT audit_account_state_account_fk
    FOREIGN KEY (account_id) REFERENCES public.account(id) ON DELETE CASCADE
);

ALTER TABLE public.audit_account_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_account_state FORCE ROW LEVEL SECURITY;

INSERT INTO public.audit_account_state (account_id)
SELECT id FROM public.account
ON CONFLICT (account_id) DO NOTHING;

DROP POLICY IF EXISTS audit_account_state_api_rls_tenant ON public.audit_account_state;
CREATE POLICY audit_account_state_api_rls_tenant
  ON public.audit_account_state FOR SELECT TO api_rls
  USING (public.rls_tenant_matches(account_id)
         AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL);
DROP POLICY IF EXISTS audit_account_state_api_rls_lock ON public.audit_account_state;
CREATE POLICY audit_account_state_api_rls_lock
  ON public.audit_account_state FOR UPDATE TO api_rls
  USING (public.rls_tenant_matches(account_id)
         AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)
  WITH CHECK (public.rls_tenant_matches(account_id)
              AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL);

DROP POLICY IF EXISTS audit_account_state_worker_rls_tenant ON public.audit_account_state;
CREATE POLICY audit_account_state_worker_rls_tenant
  ON public.audit_account_state FOR SELECT TO worker_rls
  USING (public.rls_tenant_matches(account_id)
         AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL);
DROP POLICY IF EXISTS audit_account_state_worker_rls_lock ON public.audit_account_state;
CREATE POLICY audit_account_state_worker_rls_lock
  ON public.audit_account_state FOR UPDATE TO worker_rls
  USING (public.rls_tenant_matches(account_id)
         AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)
  WITH CHECK (public.rls_tenant_matches(account_id)
              AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL);

DROP POLICY IF EXISTS audit_account_state_bootstrap ON public.audit_account_state;
CREATE POLICY audit_account_state_bootstrap
  ON public.audit_account_state FOR ALL TO auth_bootstrap
  USING (public.rls_bootstrap_context())
  WITH CHECK (public.rls_bootstrap_context());

REVOKE ALL ON TABLE public.audit_account_state FROM api_rls, worker_rls, reporting_rls;
GRANT SELECT, UPDATE ON TABLE public.audit_account_state TO api_rls, worker_rls;

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
  INSERT INTO public.audit_event (account_id, actor, action, payload_json)
  VALUES (found_account_id, 'google_oauth', 'authz'::public.audit_action, '{"provider":"google","event":"login"}'::jsonb);
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
  IF (SELECT c.relowner FROM pg_class AS c WHERE c.oid = 'public.audit_account_state'::regclass)
      IS DISTINCT FROM migration_owner THEN
    RAISE EXCEPTION 'migration owner % does not own audit_account_state', current_user;
  END IF;
END;
$$;
