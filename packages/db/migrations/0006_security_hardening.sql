-- Custom SQL migration file, put your code below! --
-- Security invariants: the migration role is the sole owner of project relations
-- and SECURITY DEFINER helpers. Runtime roles are capability-only and cannot
-- acquire ownership, create objects, inherit memberships, or mutate billing.

ALTER ROLE api_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE worker_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE reporting_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE auth_bootstrap NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$
DECLARE
  runtime_roles constant text[] := ARRAY['api_rls', 'worker_rls', 'reporting_rls', 'auth_bootstrap'];
  membership record;
BEGIN
  FOR membership IN
    SELECT parent.rolname AS parent_name, member.rolname AS member_name
    FROM pg_auth_members AS m
    JOIN pg_roles AS parent ON parent.oid = m.roleid
    JOIN pg_roles AS member ON member.oid = m.member
    WHERE member.rolname = ANY (runtime_roles)
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.parent_name, membership.member_name);
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS m
    JOIN pg_roles AS member ON member.oid = m.member
    WHERE member.rolname = ANY (runtime_roles)
  ) THEN
    RAISE EXCEPTION 'runtime role membership invariant violated';
  END IF;
END;
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC', current_user);
END;
$$;

DO $$
DECLARE
  migration_owner oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
  account_owner oid;
BEGIN
  IF (SELECT datdba FROM pg_database WHERE datname = current_database()) IS DISTINCT FROM migration_owner THEN
    RAISE EXCEPTION 'migration owner % is not the database owner', current_user;
  END IF;
  SELECT c.relowner INTO account_owner
  FROM pg_class AS c
  WHERE c.oid = 'public.account'::regclass;
  IF account_owner IS DISTINCT FROM migration_owner THEN
    RAISE EXCEPTION 'migration owner % does not own public.account', current_user;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class AS c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p')
      AND c.relowner IS DISTINCT FROM migration_owner
  ) THEN
    RAISE EXCEPTION 'migration owner % does not own every public project table', current_user;
  END IF;

  IF (SELECT p.proowner FROM pg_proc AS p WHERE p.oid = 'public.rls_tenant_matches(uuid)'::regprocedure) IS DISTINCT FROM migration_owner
     OR (SELECT p.proowner FROM pg_proc AS p WHERE p.oid = 'public.rls_bootstrap_context()'::regprocedure) IS DISTINCT FROM migration_owner
     OR (SELECT p.proowner FROM pg_proc AS p WHERE p.oid = 'public.auth_complete_google_login(text,citext,text,timestamptz,inet,text)'::regprocedure) IS DISTINCT FROM migration_owner
     OR (SELECT p.proowner FROM pg_proc AS p WHERE p.oid = 'public.auth_resolve_session(text)'::regprocedure) IS DISTINCT FROM migration_owner
     OR (SELECT p.proowner FROM pg_proc AS p WHERE p.oid = 'public.auth_rotate_session(text,text,timestamptz)'::regprocedure) IS DISTINCT FROM migration_owner
     OR (SELECT p.proowner FROM pg_proc AS p WHERE p.oid = 'public.auth_revoke_session(text)'::regprocedure) IS DISTINCT FROM migration_owner THEN
    RAISE EXCEPTION 'migration owner % does not own project SECURITY DEFINER helpers', current_user;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class AS c
    JOIN pg_roles AS r ON r.oid = c.relowner
    WHERE c.relnamespace = 'public'::regnamespace
      AND r.rolname IN ('api_rls', 'worker_rls', 'reporting_rls', 'auth_bootstrap')
  ) OR EXISTS (
    SELECT 1 FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_roles AS r ON r.oid = p.proowner
    WHERE n.nspname = 'public'
      AND r.rolname IN ('api_rls', 'worker_rls', 'reporting_rls', 'auth_bootstrap')
  ) THEN
    RAISE EXCEPTION 'runtime role owns a public relation or function';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles AS r
    WHERE NOT r.rolsuper
      AND r.rolname <> current_user
      AND r.rolname <> 'pg_database_owner'
      AND has_schema_privilege(r.rolname, 'public', 'CREATE')
  ) THEN
    RAISE EXCEPTION 'non-superuser other than migration owner can CREATE in public';
  END IF;
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.billing_event, public.entitlement, public.credit_entry FROM api_rls, worker_rls, reporting_rls, auth_bootstrap;
DROP POLICY IF EXISTS billing_event_api_rls_tenant ON public.billing_event;
CREATE POLICY billing_event_api_rls_tenant ON public.billing_event FOR SELECT TO api_rls USING (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS billing_event_worker_rls_tenant ON public.billing_event;
CREATE POLICY billing_event_worker_rls_tenant ON public.billing_event FOR SELECT TO worker_rls USING (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS billing_event_reporting_rls_tenant ON public.billing_event;
CREATE POLICY billing_event_reporting_rls_tenant ON public.billing_event FOR SELECT TO reporting_rls USING (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS entitlement_api_rls_tenant ON public.entitlement;
CREATE POLICY entitlement_api_rls_tenant ON public.entitlement FOR SELECT TO api_rls USING (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS entitlement_worker_rls_tenant ON public.entitlement;
CREATE POLICY entitlement_worker_rls_tenant ON public.entitlement FOR SELECT TO worker_rls USING (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS entitlement_reporting_rls_tenant ON public.entitlement;
CREATE POLICY entitlement_reporting_rls_tenant ON public.entitlement FOR SELECT TO reporting_rls USING (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS credit_entry_api_rls_tenant ON public.credit_entry;
CREATE POLICY credit_entry_api_rls_tenant ON public.credit_entry FOR SELECT TO api_rls USING (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS credit_entry_worker_rls_tenant ON public.credit_entry;
CREATE POLICY credit_entry_worker_rls_tenant ON public.credit_entry FOR SELECT TO worker_rls USING (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS credit_entry_reporting_rls_tenant ON public.credit_entry;
CREATE POLICY credit_entry_reporting_rls_tenant ON public.credit_entry FOR SELECT TO reporting_rls USING (public.rls_tenant_matches(account_id));

REVOKE EXECUTE ON FUNCTION public.auth_rotate_session(text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_revoke_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_rotate_session(text, text, timestamptz) TO auth_bootstrap;
GRANT EXECUTE ON FUNCTION public.auth_revoke_session(text) TO auth_bootstrap;
REVOKE EXECUTE ON FUNCTION public.auth_complete_google_login(text, citext, text, timestamptz, inet, text) FROM api_rls, worker_rls, reporting_rls;
REVOKE EXECUTE ON FUNCTION public.auth_resolve_session(text) FROM api_rls, worker_rls, reporting_rls;
REVOKE EXECUTE ON FUNCTION public.auth_rotate_session(text, text, timestamptz) FROM api_rls, worker_rls, reporting_rls;
REVOKE EXECUTE ON FUNCTION public.auth_revoke_session(text) FROM api_rls, worker_rls, reporting_rls;

CREATE OR REPLACE FUNCTION public.auth_rotate_session(
  current_session_hash text,
  replacement_session_hash text,
  replacement_expires_at timestamptz
)
RETURNS TABLE (account_id uuid, user_id uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  lookup_family_id uuid;
  found_account_id uuid;
  found_user_id uuid;
  found_session_id uuid;
  found_ip text;
  found_user_agent text;
BEGIN
  IF current_session_hash IS NULL OR current_session_hash !~ '^[0-9a-f]{64}$'
     OR replacement_session_hash IS NULL OR replacement_session_hash !~ '^[0-9a-f]{64}$'
     OR current_session_hash = replacement_session_hash
     OR replacement_expires_at IS NULL OR replacement_expires_at <= clock_timestamp()
     OR replacement_expires_at > clock_timestamp() + interval '31 days' THEN
    RETURN;
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT s.family_id INTO lookup_family_id
  FROM public.session AS s
  WHERE s.token_hash = current_session_hash;
  IF lookup_family_id IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(lookup_family_id::text, 0));
  SELECT s.account_id, s.user_id, s.id, s.ip, s.user_agent
  INTO found_account_id, found_user_id, found_session_id, found_ip, found_user_agent
  FROM public.session AS s
  JOIN public.account AS a ON a.id = s.account_id
  WHERE s.token_hash = current_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > clock_timestamp()
    AND a.status = 'active'::public.account_status
    AND a.deleted_at IS NULL
  FOR UPDATE;
  IF found_session_id IS NULL THEN RETURN; END IF;
  UPDATE public.session
  SET revoked_at = clock_timestamp(), rotated_at = clock_timestamp()
  WHERE id = found_session_id;
  INSERT INTO public.session (account_id, user_id, family_id, token_hash, expires_at, ip, user_agent)
  VALUES (found_account_id, found_user_id, lookup_family_id, replacement_session_hash, replacement_expires_at, found_ip, found_user_agent)
  RETURNING id INTO session_id;
  account_id := found_account_id;
  user_id := found_user_id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_revoke_session(input_session_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  lookup_family_id uuid;
BEGIN
  IF input_session_hash IS NULL OR input_session_hash !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT s.family_id INTO lookup_family_id
  FROM public.session AS s
  WHERE s.token_hash = input_session_hash;
  IF lookup_family_id IS NULL THEN RETURN true; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(lookup_family_id::text, 0));
  UPDATE public.session
  SET revoked_at = COALESCE(revoked_at, clock_timestamp())
  WHERE family_id = lookup_family_id;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.auth_rotate_session(text, text, timestamptz) FROM PUBLIC, api_rls, worker_rls, reporting_rls;
REVOKE EXECUTE ON FUNCTION public.auth_revoke_session(text) FROM PUBLIC, api_rls, worker_rls, reporting_rls;
GRANT EXECUTE ON FUNCTION public.auth_rotate_session(text, text, timestamptz) TO auth_bootstrap;
GRANT EXECUTE ON FUNCTION public.auth_revoke_session(text) TO auth_bootstrap;
