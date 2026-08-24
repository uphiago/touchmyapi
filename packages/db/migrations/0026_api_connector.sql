-- Dedicated application connector. It can only SET ROLE api_rls; it owns no
-- object and has no direct table/function privileges.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_connector') THEN
    CREATE ROLE api_connector LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
      NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

ALTER ROLE api_connector LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
  NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT parent.rolname AS parent_name
    FROM pg_auth_members relation
    JOIN pg_roles parent ON parent.oid = relation.roleid
    JOIN pg_roles member ON member.oid = relation.member
    WHERE member.rolname = 'api_connector' AND parent.rolname <> 'api_rls'
  LOOP
    EXECUTE format('REVOKE %I FROM api_connector', membership.parent_name);
  END LOOP;
END
$$;

GRANT api_rls TO api_connector;
REVOKE CREATE ON SCHEMA public FROM api_connector;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM api_connector;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM api_connector;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM api_connector;
