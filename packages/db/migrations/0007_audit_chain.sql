-- Dedicated accountless audit-chain boundary.  The migration owner remains
-- the only owner of the relation; runtime roles receive only the exact
-- privileges and forced-RLS policies needed by the closed writer.
CREATE TABLE public.audit_system_state (
  id text PRIMARY KEY CONSTRAINT audit_system_state_id_check CHECK (id = 'system')
);
ALTER TABLE public.audit_system_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_system_state FORCE ROW LEVEL SECURITY;
INSERT INTO public.audit_system_state (id) VALUES ('system') ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  CREATE ROLE audit_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE ROLE audit_system_connector LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER ROLE audit_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE audit_system_connector LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$
DECLARE
  membership record;
BEGIN
  FOR membership IN
    SELECT parent.rolname AS parent_name, member.rolname AS member_name
    FROM pg_auth_members AS m
    JOIN pg_roles AS parent ON parent.oid = m.roleid
    JOIN pg_roles AS member ON member.oid = m.member
    WHERE member.rolname IN ('audit_system', 'audit_system_connector')
      AND NOT (member.rolname = 'audit_system_connector' AND parent.rolname = 'audit_system')
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.parent_name, membership.member_name);
  END LOOP;
END;
$$;
GRANT audit_system TO audit_system_connector;

REVOKE CREATE ON SCHEMA public FROM audit_system, audit_system_connector;
GRANT USAGE ON SCHEMA public TO audit_system;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM audit_system, audit_system_connector;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM audit_system, audit_system_connector;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM audit_system, audit_system_connector;
GRANT SELECT, INSERT ON TABLE public.audit_event TO audit_system;
GRANT SELECT, UPDATE ON TABLE public.audit_system_state TO audit_system;

-- The historical bootstrap policy was PUBLIC.  Narrow it to its actual
-- bootstrap role so the system role never needs helper-function EXECUTE merely
-- to evaluate an unrelated permissive policy.
DROP POLICY IF EXISTS audit_event_bootstrap ON public.audit_event;
CREATE POLICY audit_event_bootstrap ON public.audit_event
  FOR ALL TO auth_bootstrap
  USING (public.rls_bootstrap_context())
  WITH CHECK (public.rls_bootstrap_context());

DROP POLICY IF EXISTS audit_event_audit_system_select ON public.audit_event;
CREATE POLICY audit_event_audit_system_select
  ON public.audit_event FOR SELECT TO audit_system
  USING (account_id IS NULL);
DROP POLICY IF EXISTS audit_event_audit_system_insert ON public.audit_event;
CREATE POLICY audit_event_audit_system_insert
  ON public.audit_event FOR INSERT TO audit_system
  WITH CHECK (account_id IS NULL);
DROP POLICY IF EXISTS audit_system_state_audit_system_select ON public.audit_system_state;
CREATE POLICY audit_system_state_audit_system_select
  ON public.audit_system_state FOR SELECT TO audit_system
  USING (id = 'system');
DROP POLICY IF EXISTS audit_system_state_audit_system_lock ON public.audit_system_state;
CREATE POLICY audit_system_state_audit_system_lock
  ON public.audit_system_state FOR UPDATE TO audit_system
  USING (id = 'system') WITH CHECK (id = 'system');

DO $$
DECLARE
  migration_owner oid := (SELECT oid FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF (SELECT datdba FROM pg_database WHERE datname = current_database()) IS DISTINCT FROM migration_owner THEN
    RAISE EXCEPTION 'migration owner % is not the database owner', current_user;
  END IF;
  IF (SELECT c.relowner FROM pg_class AS c WHERE c.oid = 'public.audit_system_state'::regclass)
      IS DISTINCT FROM migration_owner THEN
    RAISE EXCEPTION 'migration owner % does not own audit_system_state', current_user;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class AS c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relowner IN (SELECT oid FROM pg_roles WHERE rolname IN ('audit_system', 'audit_system_connector'))
  ) OR EXISTS (
    SELECT 1 FROM pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proowner IN (SELECT oid FROM pg_roles WHERE rolname IN ('audit_system', 'audit_system_connector'))
  ) THEN
    RAISE EXCEPTION 'audit system role owns a public object';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members AS m
    JOIN pg_roles AS member ON member.oid = m.member
    JOIN pg_roles AS parent ON parent.oid = m.roleid
    WHERE member.rolname IN ('audit_system', 'audit_system_connector')
      AND NOT (member.rolname = 'audit_system_connector' AND parent.rolname = 'audit_system')
  ) THEN
    RAISE EXCEPTION 'audit system role has unexpected membership';
  END IF;
END;
$$;
