-- Custom SQL migration file, put your code below! --
DROP POLICY IF EXISTS assessment_bootstrap ON public.assessment;
DROP POLICY IF EXISTS authorization_attestation_bootstrap ON public.authorization_attestation;
DROP POLICY IF EXISTS verification_bootstrap ON public.verification;
DROP POLICY IF EXISTS job_bootstrap ON public.job;
DROP POLICY IF EXISTS runner_execution_bootstrap ON public.runner_execution;
DROP POLICY IF EXISTS credential_bootstrap ON public.credential;
DROP POLICY IF EXISTS finding_bootstrap ON public.finding;
DROP POLICY IF EXISTS report_bootstrap ON public.report;
DROP POLICY IF EXISTS credit_entry_bootstrap ON public.credit_entry;
DROP POLICY IF EXISTS billing_event_bootstrap ON public.billing_event;
DROP POLICY IF EXISTS entitlement_bootstrap ON public.entitlement;
DROP POLICY IF EXISTS agent_bootstrap ON public.agent;
DROP POLICY IF EXISTS notification_bootstrap ON public.notification;
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

CREATE OR REPLACE FUNCTION public.auth_resolve_session(input_session_hash text)
RETURNS TABLE (account_id uuid, user_id uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF input_session_hash IS NULL OR input_session_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  RETURN QUERY
  SELECT s.account_id, s.user_id, s.id
  FROM public.session AS s
  JOIN public.account AS a ON a.id = s.account_id
  JOIN public."user" AS u ON u.id = s.user_id AND u.account_id = s.account_id
  WHERE s.token_hash = input_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > clock_timestamp()
    AND a.status = 'active'::public.account_status
    AND a.deleted_at IS NULL;
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
  IF current_session_hash IS NULL OR current_session_hash !~ '^[0-9a-f]{64}$'
     OR replacement_session_hash IS NULL OR replacement_session_hash !~ '^[0-9a-f]{64}$'
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
    AND a.deleted_at IS NULL
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
  IF input_session_hash IS NULL OR input_session_hash !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
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
