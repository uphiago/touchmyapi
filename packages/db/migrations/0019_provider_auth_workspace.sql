-- Provider-neutral login bootstrap. Customer identity is immutable by
-- provider/subject; email remains mutable contact data and never grants a
-- membership. All first-workspace state and the login audit commit together.
CREATE OR REPLACE FUNCTION public.auth_complete_provider_login(
  login_provider public.identity_provider,
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
  home_account_id uuid;
  found_user_id uuid;
  previous_event_id uuid;
  oauth_actor text;
BEGIN
  IF login_provider IS NULL
     OR login_provider NOT IN (
       'google'::public.identity_provider,
       'github'::public.identity_provider
     )
     OR p_provider_subject IS NULL OR btrim(p_provider_subject) = ''
     OR octet_length(p_provider_subject) > 256
     OR login_email IS NULL
     OR octet_length(login_email::text) > 320
     OR login_email::text !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     OR session_hash IS NULL OR session_hash !~ '^[0-9a-f]{64}$'
     OR session_expires_at IS NULL OR session_expires_at <= clock_timestamp()
     OR session_expires_at > clock_timestamp() + interval '31 days'
     OR client_user_agent IS NOT NULL AND octet_length(client_user_agent) > 1024 THEN
    RETURN;
  END IF;

  PERFORM set_config('app.auth_bootstrap', '1', true);
  PERFORM pg_advisory_xact_lock(
    hashtextextended(login_provider::text || ':' || p_provider_subject, 0)
  );

  SELECT u.id, u.account_id
  INTO found_user_id, home_account_id
  FROM public."user" AS u
  WHERE u.provider = login_provider
    AND u.provider_subject = p_provider_subject
  FOR UPDATE OF u;

  IF found_user_id IS NULL THEN
    INSERT INTO public.account (status, settings_ia_enabled)
    VALUES ('active'::public.account_status, true)
    RETURNING id INTO found_account_id;

    INSERT INTO public.audit_account_state (account_id)
    VALUES (found_account_id);

    INSERT INTO public."user" (account_id, provider, provider_subject, email)
    VALUES (found_account_id, login_provider, p_provider_subject, login_email)
    RETURNING id INTO found_user_id;

    INSERT INTO public.account_membership (account_id, user_id, role, status)
    VALUES (
      found_account_id,
      found_user_id,
      'owner'::public.membership_role,
      'active'::public.membership_status
    );
  ELSE
    SELECT membership.account_id
    INTO found_account_id
    FROM public.account_membership AS membership
    JOIN public.account AS candidate_account
      ON candidate_account.id = membership.account_id
    WHERE membership.user_id = found_user_id
      AND membership.status = 'active'::public.membership_status
      AND candidate_account.status = 'active'::public.account_status
      AND candidate_account.deleted_at IS NULL
    ORDER BY
      (membership.account_id = home_account_id) DESC,
      membership.created_at,
      membership.account_id
    FOR UPDATE OF membership, candidate_account
    LIMIT 1;

    IF found_account_id IS NULL THEN
      RETURN;
    END IF;

    UPDATE public."user"
    SET email = login_email
    WHERE id = found_user_id;
  END IF;

  INSERT INTO public.session (
    account_id, user_id, token_hash, expires_at, ip, user_agent
  ) VALUES (
    found_account_id, found_user_id, session_hash, session_expires_at,
    client_ip, client_user_agent
  )
  RETURNING id INTO session_id;

  PERFORM 1
  FROM public.audit_account_state AS state
  WHERE state.account_id = found_account_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit account state unavailable';
  END IF;

  SELECT event.id
  INTO previous_event_id
  FROM public.audit_event AS event
  WHERE event.account_id = found_account_id
  ORDER BY event.chain_seq DESC
  LIMIT 1;

  oauth_actor := login_provider::text || '_oauth';
  INSERT INTO public.audit_event (
    account_id, actor, action, prev_event_id, payload_json
  ) VALUES (
    found_account_id,
    oauth_actor,
    'authz'::public.audit_action,
    previous_event_id,
    jsonb_build_object('provider', login_provider::text, 'event', 'login')
  );

  account_id := found_account_id;
  user_id := found_user_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_complete_provider_login(
  public.identity_provider, text, citext, text, timestamptz, inet, text
) FROM PUBLIC, api_rls, worker_rls, reporting_rls, queue_control,
       queue_connector, admin_queue_connector;
GRANT EXECUTE ON FUNCTION public.auth_complete_provider_login(
  public.identity_provider, text, citext, text, timestamptz, inet, text
) TO auth_bootstrap;
ALTER FUNCTION public.auth_complete_provider_login(
  public.identity_provider, text, citext, text, timestamptz, inet, text
) OWNER TO CURRENT_USER;

-- Compatibility for existing Google callers and identities while the API
-- migrates to the provider-neutral store. This wrapper retains its historical
-- fixed signature and grant boundary.
CREATE OR REPLACE FUNCTION public.auth_complete_google_login(
  p_provider_subject text,
  login_email citext,
  session_hash text,
  session_expires_at timestamptz,
  client_ip inet,
  client_user_agent text
)
RETURNS TABLE (account_id uuid, user_id uuid, session_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT result.account_id, result.user_id, result.session_id
  FROM public.auth_complete_provider_login(
    'google'::public.identity_provider,
    p_provider_subject,
    login_email,
    session_hash,
    session_expires_at,
    client_ip,
    client_user_agent
  ) AS result;
$$;

REVOKE ALL ON FUNCTION public.auth_complete_google_login(
  text, citext, text, timestamptz, inet, text
) FROM PUBLIC, api_rls, worker_rls, reporting_rls, queue_control,
       queue_connector, admin_queue_connector;
GRANT EXECUTE ON FUNCTION public.auth_complete_google_login(
  text, citext, text, timestamptz, inet, text
) TO auth_bootstrap;
ALTER FUNCTION public.auth_complete_google_login(
  text, citext, text, timestamptz, inet, text
) OWNER TO CURRENT_USER;
