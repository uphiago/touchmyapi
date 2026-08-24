-- Custom SQL migration file, put your code below! --
-- Least-privilege runtime roles and default-deny RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_rls') THEN CREATE ROLE api_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worker_rls') THEN CREATE ROLE worker_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_rls') THEN CREATE ROLE reporting_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_bootstrap') THEN CREATE ROLE auth_bootstrap NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
END $$;
ALTER ROLE api_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
ALTER ROLE worker_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
ALTER ROLE reporting_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
ALTER ROLE auth_bootstrap NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO api_rls, worker_rls, reporting_rls, auth_bootstrap;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.rls_tenant_matches(candidate uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT candidate IS NOT NULL
     AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL
     AND current_setting('app.tenant', true) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
     AND candidate::text = current_setting('app.tenant', true)
$$;
CREATE OR REPLACE FUNCTION public.rls_bootstrap_context()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT current_setting('app.auth_bootstrap', true) = '1'
     AND current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.account'::regclass))
$$;
REVOKE EXECUTE ON FUNCTION public.rls_tenant_matches(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_bootstrap_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_tenant_matches(uuid) TO api_rls, worker_rls, reporting_rls;
GRANT EXECUTE ON FUNCTION public.rls_bootstrap_context() TO api_rls, worker_rls, reporting_rls;

ALTER TABLE public.account ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_api_rls_tenant ON public.account;
CREATE POLICY account_api_rls_tenant ON public.account FOR ALL TO api_rls USING ((public.rls_tenant_matches(id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS account_worker_rls_tenant ON public.account;
CREATE POLICY account_worker_rls_tenant ON public.account FOR ALL TO worker_rls USING ((public.rls_tenant_matches(id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS account_reporting_rls_tenant ON public.account;
CREATE POLICY account_reporting_rls_tenant ON public.account FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS account_bootstrap ON public.account;
CREATE POLICY account_bootstrap ON public.account FOR ALL TO PUBLIC USING (public.rls_bootstrap_context()) WITH CHECK (public.rls_bootstrap_context());

ALTER TABLE public."user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."user" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_api_rls_tenant ON public."user";
CREATE POLICY user_api_rls_tenant ON public."user" FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS user_worker_rls_tenant ON public."user";
CREATE POLICY user_worker_rls_tenant ON public."user" FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS user_reporting_rls_tenant ON public."user";
CREATE POLICY user_reporting_rls_tenant ON public."user" FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS user_bootstrap ON public."user";
CREATE POLICY user_bootstrap ON public."user" FOR ALL TO PUBLIC USING (public.rls_bootstrap_context()) WITH CHECK (public.rls_bootstrap_context());

ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_api_rls_tenant ON public.session;
CREATE POLICY session_api_rls_tenant ON public.session FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS session_worker_rls_tenant ON public.session;
CREATE POLICY session_worker_rls_tenant ON public.session FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS session_reporting_rls_tenant ON public.session;
CREATE POLICY session_reporting_rls_tenant ON public.session FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS session_bootstrap ON public.session;
CREATE POLICY session_bootstrap ON public.session FOR ALL TO PUBLIC USING (public.rls_bootstrap_context()) WITH CHECK (public.rls_bootstrap_context());

ALTER TABLE public.assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assessment_api_rls_tenant ON public.assessment;
CREATE POLICY assessment_api_rls_tenant ON public.assessment FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS assessment_worker_rls_tenant ON public.assessment;
CREATE POLICY assessment_worker_rls_tenant ON public.assessment FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS assessment_reporting_rls_tenant ON public.assessment;
CREATE POLICY assessment_reporting_rls_tenant ON public.assessment FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.authorization_attestation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authorization_attestation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS authorization_attestation_api_rls_tenant ON public.authorization_attestation;
CREATE POLICY authorization_attestation_api_rls_tenant ON public.authorization_attestation FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS authorization_attestation_worker_rls_tenant ON public.authorization_attestation;
CREATE POLICY authorization_attestation_worker_rls_tenant ON public.authorization_attestation FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS authorization_attestation_reporting_rls_tenant ON public.authorization_attestation;
CREATE POLICY authorization_attestation_reporting_rls_tenant ON public.authorization_attestation FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS verification_api_rls_tenant ON public.verification;
CREATE POLICY verification_api_rls_tenant ON public.verification FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS verification_worker_rls_tenant ON public.verification;
CREATE POLICY verification_worker_rls_tenant ON public.verification FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS verification_reporting_rls_tenant ON public.verification;
CREATE POLICY verification_reporting_rls_tenant ON public.verification FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.job ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS job_api_rls_tenant ON public.job;
CREATE POLICY job_api_rls_tenant ON public.job FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS job_worker_rls_tenant ON public.job;
CREATE POLICY job_worker_rls_tenant ON public.job FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS job_reporting_rls_tenant ON public.job;
CREATE POLICY job_reporting_rls_tenant ON public.job FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.runner_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runner_execution FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runner_execution_api_rls_tenant ON public.runner_execution;
CREATE POLICY runner_execution_api_rls_tenant ON public.runner_execution FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS runner_execution_worker_rls_tenant ON public.runner_execution;
CREATE POLICY runner_execution_worker_rls_tenant ON public.runner_execution FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS runner_execution_reporting_rls_tenant ON public.runner_execution;
CREATE POLICY runner_execution_reporting_rls_tenant ON public.runner_execution FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credential FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credential_api_rls_tenant ON public.credential;
CREATE POLICY credential_api_rls_tenant ON public.credential FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS credential_worker_rls_tenant ON public.credential;
CREATE POLICY credential_worker_rls_tenant ON public.credential FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS credential_reporting_rls_tenant ON public.credential;
CREATE POLICY credential_reporting_rls_tenant ON public.credential FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finding FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finding_api_rls_tenant ON public.finding;
CREATE POLICY finding_api_rls_tenant ON public.finding FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS finding_worker_rls_tenant ON public.finding;
CREATE POLICY finding_worker_rls_tenant ON public.finding FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS finding_reporting_rls_tenant ON public.finding;
CREATE POLICY finding_reporting_rls_tenant ON public.finding FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.report ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_api_rls_tenant ON public.report;
CREATE POLICY report_api_rls_tenant ON public.report FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS report_worker_rls_tenant ON public.report;
CREATE POLICY report_worker_rls_tenant ON public.report FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS report_reporting_rls_tenant ON public.report;
CREATE POLICY report_reporting_rls_tenant ON public.report FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.credit_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_entry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_entry_api_rls_tenant ON public.credit_entry;
CREATE POLICY credit_entry_api_rls_tenant ON public.credit_entry FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS credit_entry_worker_rls_tenant ON public.credit_entry;
CREATE POLICY credit_entry_worker_rls_tenant ON public.credit_entry FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS credit_entry_reporting_rls_tenant ON public.credit_entry;
CREATE POLICY credit_entry_reporting_rls_tenant ON public.credit_entry FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.billing_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_event_api_rls_tenant ON public.billing_event;
CREATE POLICY billing_event_api_rls_tenant ON public.billing_event FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS billing_event_worker_rls_tenant ON public.billing_event;
CREATE POLICY billing_event_worker_rls_tenant ON public.billing_event FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS billing_event_reporting_rls_tenant ON public.billing_event;
CREATE POLICY billing_event_reporting_rls_tenant ON public.billing_event FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlement FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entitlement_api_rls_tenant ON public.entitlement;
CREATE POLICY entitlement_api_rls_tenant ON public.entitlement FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS entitlement_worker_rls_tenant ON public.entitlement;
CREATE POLICY entitlement_worker_rls_tenant ON public.entitlement FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS entitlement_reporting_rls_tenant ON public.entitlement;
CREATE POLICY entitlement_reporting_rls_tenant ON public.entitlement FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.agent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_api_rls_tenant ON public.agent;
CREATE POLICY agent_api_rls_tenant ON public.agent FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS agent_worker_rls_tenant ON public.agent;
CREATE POLICY agent_worker_rls_tenant ON public.agent FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS agent_reporting_rls_tenant ON public.agent;
CREATE POLICY agent_reporting_rls_tenant ON public.agent FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
ALTER TABLE public.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_event_api_rls_tenant ON public.audit_event;
CREATE POLICY audit_event_api_rls_tenant ON public.audit_event FOR SELECT TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS audit_event_api_rls_insert ON public.audit_event;
CREATE POLICY audit_event_api_rls_insert ON public.audit_event FOR INSERT TO api_rls WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS audit_event_worker_rls_tenant ON public.audit_event;
CREATE POLICY audit_event_worker_rls_tenant ON public.audit_event FOR SELECT TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS audit_event_worker_rls_insert ON public.audit_event;
CREATE POLICY audit_event_worker_rls_insert ON public.audit_event FOR INSERT TO worker_rls WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS audit_event_reporting_rls_tenant ON public.audit_event;
CREATE POLICY audit_event_reporting_rls_tenant ON public.audit_event FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS audit_event_bootstrap ON public.audit_event;
CREATE POLICY audit_event_bootstrap ON public.audit_event FOR ALL TO PUBLIC USING (public.rls_bootstrap_context()) WITH CHECK (public.rls_bootstrap_context());

ALTER TABLE public.notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_api_rls_tenant ON public.notification;
CREATE POLICY notification_api_rls_tenant ON public.notification FOR ALL TO api_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS notification_worker_rls_tenant ON public.notification;
CREATE POLICY notification_worker_rls_tenant ON public.notification FOR ALL TO worker_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL)) WITH CHECK ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
DROP POLICY IF EXISTS notification_reporting_rls_tenant ON public.notification;
CREATE POLICY notification_reporting_rls_tenant ON public.notification FOR SELECT TO reporting_rls USING ((public.rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL));
GRANT SELECT ON TABLE public.account TO api_rls;
GRANT SELECT ON TABLE public."user" TO api_rls;
GRANT SELECT ON TABLE public.assessment TO api_rls;
GRANT SELECT ON TABLE public.authorization_attestation TO api_rls;
GRANT SELECT ON TABLE public.verification TO api_rls;
GRANT SELECT ON TABLE public.playbook TO api_rls;
GRANT SELECT ON TABLE public.credential TO api_rls;
GRANT SELECT ON TABLE public.finding TO api_rls;
GRANT SELECT ON TABLE public.report TO api_rls;
GRANT SELECT ON TABLE public.credit_entry TO api_rls;
GRANT SELECT ON TABLE public.entitlement TO api_rls;
GRANT SELECT ON TABLE public.agent TO api_rls;
GRANT SELECT ON TABLE public.audit_event TO api_rls;
GRANT SELECT ON TABLE public.notification TO api_rls;
GRANT INSERT ON TABLE public.assessment TO api_rls;
GRANT INSERT ON TABLE public.authorization_attestation TO api_rls;
GRANT INSERT ON TABLE public.verification TO api_rls;
GRANT INSERT ON TABLE public.credential TO api_rls;
GRANT INSERT ON TABLE public.audit_event TO api_rls;
GRANT INSERT ON TABLE public.agent TO api_rls;
GRANT UPDATE ON TABLE public.account TO api_rls;
GRANT UPDATE ON TABLE public.assessment TO api_rls;
GRANT UPDATE ON TABLE public.verification TO api_rls;
GRANT UPDATE ON TABLE public.credential TO api_rls;
GRANT UPDATE ON TABLE public.agent TO api_rls;
GRANT UPDATE ON TABLE public.notification TO api_rls;
GRANT DELETE ON TABLE public.credential TO api_rls;
GRANT DELETE ON TABLE public.agent TO api_rls;
GRANT SELECT ON TABLE public.account TO worker_rls;
GRANT SELECT ON TABLE public."user" TO worker_rls;
GRANT SELECT ON TABLE public.assessment TO worker_rls;
GRANT SELECT ON TABLE public.authorization_attestation TO worker_rls;
GRANT SELECT ON TABLE public.verification TO worker_rls;
GRANT SELECT ON TABLE public.playbook TO worker_rls;
GRANT SELECT ON TABLE public.job TO worker_rls;
GRANT SELECT ON TABLE public.runner_execution TO worker_rls;
GRANT SELECT ON TABLE public.credential TO worker_rls;
GRANT SELECT ON TABLE public.finding TO worker_rls;
GRANT SELECT ON TABLE public.report TO worker_rls;
GRANT SELECT ON TABLE public.credit_entry TO worker_rls;
GRANT SELECT ON TABLE public.billing_event TO worker_rls;
GRANT SELECT ON TABLE public.entitlement TO worker_rls;
GRANT SELECT ON TABLE public.agent TO worker_rls;
GRANT SELECT ON TABLE public.audit_event TO worker_rls;
GRANT SELECT ON TABLE public.notification TO worker_rls;
GRANT INSERT ON TABLE public.job TO worker_rls;
GRANT INSERT ON TABLE public.runner_execution TO worker_rls;
GRANT INSERT ON TABLE public.finding TO worker_rls;
GRANT INSERT ON TABLE public.report TO worker_rls;
GRANT INSERT ON TABLE public.credit_entry TO worker_rls;
GRANT INSERT ON TABLE public.billing_event TO worker_rls;
GRANT INSERT ON TABLE public.entitlement TO worker_rls;
GRANT INSERT ON TABLE public.audit_event TO worker_rls;
GRANT INSERT ON TABLE public.notification TO worker_rls;
GRANT UPDATE ON TABLE public.assessment TO worker_rls;
GRANT UPDATE ON TABLE public.verification TO worker_rls;
GRANT UPDATE ON TABLE public.job TO worker_rls;
GRANT UPDATE ON TABLE public.runner_execution TO worker_rls;
GRANT UPDATE ON TABLE public.finding TO worker_rls;
GRANT UPDATE ON TABLE public.report TO worker_rls;
GRANT UPDATE ON TABLE public.billing_event TO worker_rls;
GRANT UPDATE ON TABLE public.entitlement TO worker_rls;
GRANT UPDATE ON TABLE public.agent TO worker_rls;
GRANT UPDATE ON TABLE public.notification TO worker_rls;
GRANT DELETE ON TABLE public.job TO worker_rls;
GRANT DELETE ON TABLE public.runner_execution TO worker_rls;
GRANT DELETE ON TABLE public.credential TO worker_rls;
GRANT SELECT ON TABLE public.account TO reporting_rls;
GRANT SELECT ON TABLE public."user" TO reporting_rls;
GRANT SELECT ON TABLE public.assessment TO reporting_rls;
GRANT SELECT ON TABLE public.authorization_attestation TO reporting_rls;
GRANT SELECT ON TABLE public.verification TO reporting_rls;
GRANT SELECT ON TABLE public.playbook TO reporting_rls;
GRANT SELECT ON TABLE public.job TO reporting_rls;
GRANT SELECT ON TABLE public.runner_execution TO reporting_rls;
GRANT SELECT ON TABLE public.finding TO reporting_rls;
GRANT SELECT ON TABLE public.report TO reporting_rls;
GRANT SELECT ON TABLE public.credit_entry TO reporting_rls;
GRANT SELECT ON TABLE public.billing_event TO reporting_rls;
GRANT SELECT ON TABLE public.entitlement TO reporting_rls;
GRANT SELECT ON TABLE public.agent TO reporting_rls;
GRANT SELECT ON TABLE public.audit_event TO reporting_rls;
GRANT SELECT ON TABLE public.notification TO reporting_rls;

DROP FUNCTION IF EXISTS public.auth_complete_google_login(text, citext, text, timestamptz, inet, text);
DROP FUNCTION IF EXISTS public.auth_resolve_session(text);
DROP FUNCTION IF EXISTS public.auth_rotate_session(text, text, timestamptz);
DROP FUNCTION IF EXISTS public.auth_revoke_session(text);

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
BEGIN
  IF p_provider_subject IS NULL OR btrim(p_provider_subject) = ''
     OR session_hash IS NULL OR btrim(session_hash) = ''
     OR session_expires_at IS NULL OR session_expires_at <= clock_timestamp()
     OR session_expires_at > clock_timestamp() + interval '31 days' THEN
    RETURN;
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_subject, 0));
  SELECT u.account_id, u.id INTO found_account_id, found_user_id
  FROM public."user" AS u
  WHERE u.provider = 'google'::public.identity_provider
    AND u.provider_subject = p_provider_subject;
  IF found_user_id IS NULL THEN
    INSERT INTO public.account (status, settings_ia_enabled)
    VALUES ('active'::public.account_status, true)
    RETURNING id INTO found_account_id;
    INSERT INTO public."user" (account_id, provider, provider_subject, email)
    VALUES (found_account_id, 'google'::public.identity_provider, p_provider_subject, login_email)
    RETURNING id INTO found_user_id;
  ELSE
    UPDATE public."user" SET email = login_email WHERE id = found_user_id;
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

CREATE OR REPLACE FUNCTION public.auth_resolve_session(input_session_hash text)
RETURNS TABLE (account_id uuid, user_id uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF input_session_hash IS NULL OR btrim(input_session_hash) = '' THEN RETURN; END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  RETURN QUERY
  SELECT s.account_id, s.user_id, s.id
  FROM public.session AS s
  JOIN public.account AS a ON a.id = s.account_id
  JOIN public."user" AS u ON u.id = s.user_id AND u.account_id = s.account_id
  WHERE s.token_hash = input_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > clock_timestamp()
    AND a.status = 'active'::public.account_status;
END;
$$;

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
  found_account_id uuid;
  found_user_id uuid;
  found_session_id uuid;
BEGIN
  IF current_session_hash IS NULL OR btrim(current_session_hash) = ''
     OR replacement_session_hash IS NULL OR btrim(replacement_session_hash) = ''
     OR current_session_hash = replacement_session_hash
     OR replacement_expires_at IS NULL OR replacement_expires_at <= clock_timestamp()
     OR replacement_expires_at > clock_timestamp() + interval '31 days' THEN
    RETURN;
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT s.account_id, s.user_id, s.id INTO found_account_id, found_user_id, found_session_id
  FROM public.session AS s
  JOIN public.account AS a ON a.id = s.account_id
  WHERE s.token_hash = current_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > clock_timestamp()
    AND a.status = 'active'::public.account_status
  FOR UPDATE;
  IF found_session_id IS NULL THEN RETURN; END IF;
  UPDATE public.session
  SET token_hash = replacement_session_hash,
      rotated_at = clock_timestamp(),
      expires_at = replacement_expires_at
  WHERE id = found_session_id;
  account_id := found_account_id;
  user_id := found_user_id;
  session_id := found_session_id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_revoke_session(input_session_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF input_session_hash IS NULL OR btrim(input_session_hash) = '' THEN RETURN true; END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  UPDATE public.session SET revoked_at = COALESCE(revoked_at, clock_timestamp())
  WHERE token_hash = input_session_hash;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.auth_complete_google_login(text, citext, text, timestamptz, inet, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_resolve_session(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_rotate_session(text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_revoke_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_complete_google_login(text, citext, text, timestamptz, inet, text) TO auth_bootstrap;
GRANT EXECUTE ON FUNCTION public.auth_resolve_session(text) TO auth_bootstrap;
GRANT EXECUTE ON FUNCTION public.auth_rotate_session(text, text, timestamptz) TO auth_bootstrap;
GRANT EXECUTE ON FUNCTION public.auth_revoke_session(text) TO auth_bootstrap;
ALTER FUNCTION public.auth_complete_google_login(text, citext, text, timestamptz, inet, text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.auth_resolve_session(text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.auth_rotate_session(text, text, timestamptz) OWNER TO CURRENT_USER;
ALTER FUNCTION public.auth_revoke_session(text) OWNER TO CURRENT_USER;
