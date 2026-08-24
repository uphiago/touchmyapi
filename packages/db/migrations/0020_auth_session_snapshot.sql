-- Dedicated login principal and sanitized session projection. The connector
-- can only SET ROLE to auth_bootstrap; it receives no direct project object
-- privilege. Auth functions remain fixed-signature SECURITY DEFINER helpers.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_connector') THEN
    CREATE ROLE auth_connector LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
      NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

ALTER ROLE auth_connector LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
  NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$
DECLARE
  membership record;
BEGIN
  FOR membership IN
    SELECT parent.rolname AS parent_name, member.rolname AS member_name
    FROM pg_auth_members AS role_membership
    JOIN pg_roles AS parent ON parent.oid = role_membership.roleid
    JOIN pg_roles AS member ON member.oid = role_membership.member
    WHERE member.rolname = 'auth_connector'
      AND parent.rolname <> 'auth_bootstrap'
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.parent_name, membership.member_name);
  END LOOP;
END
$$;

GRANT auth_bootstrap TO auth_connector;
REVOKE CREATE ON SCHEMA public FROM auth_connector;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM auth_connector;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM auth_connector;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM auth_connector;

CREATE OR REPLACE FUNCTION public.auth_session_snapshot(input_session_hash text)
RETURNS TABLE (
  account_id uuid,
  user_id uuid,
  session_id uuid,
  email citext,
  role public.membership_role,
  membership_status public.membership_status,
  plan public.entitlement_plan,
  ia_enabled boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF input_session_hash IS NULL OR input_session_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  RETURN QUERY
  SELECT
    session_row.account_id,
    session_row.user_id,
    session_row.id,
    identity.email,
    membership.role,
    membership.status,
    COALESCE(current_entitlement.plan, 'free_unverified'::public.entitlement_plan),
    account_row.settings_ia_enabled
  FROM public.session AS session_row
  JOIN public.account AS account_row
    ON account_row.id = session_row.account_id
  JOIN public."user" AS identity
    ON identity.id = session_row.user_id
  JOIN public.account_membership AS membership
    ON membership.account_id = session_row.account_id
   AND membership.user_id = session_row.user_id
  LEFT JOIN LATERAL (
    SELECT entitlement.plan
    FROM public.entitlement AS entitlement
    WHERE entitlement.account_id = session_row.account_id
      AND entitlement.status = 'active'::public.entitlement_status
      AND (entitlement.expires_at IS NULL OR entitlement.expires_at > clock_timestamp())
    ORDER BY entitlement.started_at DESC, entitlement.id DESC
    LIMIT 1
  ) AS current_entitlement ON true
  WHERE session_row.token_hash = input_session_hash
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at > clock_timestamp()
    AND account_row.status = 'active'::public.account_status
    AND account_row.deleted_at IS NULL
    AND identity.email IS NOT NULL
    AND membership.status = 'active'::public.membership_status;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_session_snapshot(text)
  FROM PUBLIC, api_rls, worker_rls, reporting_rls, auth_connector,
       queue_control, queue_connector, admin_queue_connector;
GRANT EXECUTE ON FUNCTION public.auth_session_snapshot(text) TO auth_bootstrap;
ALTER FUNCTION public.auth_session_snapshot(text) OWNER TO CURRENT_USER;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member ON member.oid = membership.member
    JOIN pg_roles AS parent ON parent.oid = membership.roleid
    WHERE member.rolname = 'auth_connector'
      AND parent.rolname <> 'auth_bootstrap'
  ) THEN
    RAISE EXCEPTION 'auth connector has unexpected membership';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class AS relation
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relowner = 'auth_connector'::regrole
  ) OR EXISTS (
    SELECT 1 FROM pg_proc AS function
    WHERE function.pronamespace = 'public'::regnamespace
      AND function.proowner = 'auth_connector'::regrole
  ) THEN
    RAISE EXCEPTION 'auth connector owns a public object';
  END IF;
END
$$;
