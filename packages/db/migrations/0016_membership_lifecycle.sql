-- Membership lifecycle hardening: active membership is part of session
-- resolution, and removal revokes every session for the removed user/account.
CREATE OR REPLACE FUNCTION public.auth_create_invitation(
  p_session_hash text,
  p_target_account_id uuid,
  p_email citext,
  p_proposed_role public.membership_role,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS TABLE (invitation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  inviter_id uuid;
  current_account_id uuid;
  inviter_allowed boolean;
  created_id uuid;
  previous_event_id uuid;
BEGIN
  IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_target_account_id IS NULL
     OR p_email IS NULL OR p_email::text !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_expires_at IS NULL OR p_expires_at <= clock_timestamp()
     OR p_expires_at > clock_timestamp() + interval '30 days'
     OR p_proposed_role IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT s.user_id, s.account_id INTO inviter_id, current_account_id
  FROM public.session AS s
  JOIN public.account AS a ON a.id = s.account_id
  JOIN public.account_membership AS current_membership
    ON current_membership.account_id = s.account_id
   AND current_membership.user_id = s.user_id
   AND current_membership.status = 'active'::public.membership_status
  WHERE s.token_hash = p_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > clock_timestamp()
    AND a.status = 'active'::public.account_status
    AND a.deleted_at IS NULL
  FOR UPDATE OF s;
  IF inviter_id IS NULL OR current_account_id <> p_target_account_id THEN RETURN; END IF;
  SELECT true INTO inviter_allowed
  FROM public.account_membership AS m
  JOIN public.account AS target_account ON target_account.id = m.account_id
  WHERE m.account_id = p_target_account_id
    AND m.user_id = inviter_id
    AND m.status = 'active'::public.membership_status
    AND m.role IN ('owner'::public.membership_role, 'admin'::public.membership_role)
    AND target_account.status = 'active'::public.account_status
    AND target_account.deleted_at IS NULL
  FOR SHARE;
  IF inviter_allowed IS DISTINCT FROM true THEN RETURN; END IF;
  INSERT INTO public.account_invitation (
    account_id, token_hash, email, proposed_role, status, expires_at, invited_by_user_id
  ) VALUES (
    p_target_account_id, p_token_hash, p_email, p_proposed_role, 'pending'::public.invitation_status,
    p_expires_at, inviter_id
  ) RETURNING id INTO created_id;
  INSERT INTO public.audit_account_state (account_id)
  VALUES (p_target_account_id)
  ON CONFLICT DO NOTHING;
  PERFORM 1
  FROM public.audit_account_state AS state
  WHERE state.account_id = p_target_account_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'audit account state unavailable'; END IF;
  SELECT event.id INTO previous_event_id
  FROM public.audit_event AS event
  WHERE event.account_id = p_target_account_id
  ORDER BY event.chain_seq DESC
  LIMIT 1;
  INSERT INTO public.audit_event (account_id, actor, action, prev_event_id, payload_json)
  VALUES (
    p_target_account_id,
    inviter_id::text,
    'authz'::public.audit_action,
    previous_event_id,
    jsonb_build_object('event', 'invitation_created', 'invitation_id', created_id)
  );
  invitation_id := created_id;
  RETURN NEXT;
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
  INSERT INTO public.account_membership (account_id, user_id, role, status)
  VALUES (found_account_id, found_user_id, 'owner'::public.membership_role, 'active'::public.membership_status)
  ON CONFLICT ON CONSTRAINT account_membership_account_user_unique DO NOTHING;
  INSERT INTO public.session (account_id, user_id, token_hash, expires_at, ip, user_agent)
  VALUES (found_account_id, found_user_id, session_hash, session_expires_at, client_ip, client_user_agent)
  RETURNING id INTO session_id;
  PERFORM 1
  FROM public.audit_account_state AS state
  WHERE state.account_id = found_account_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'audit account state unavailable'; END IF;
  SELECT event.id INTO previous_event_id
  FROM public.audit_event AS event
  WHERE event.account_id = found_account_id
  ORDER BY event.chain_seq DESC
  LIMIT 1;
  INSERT INTO public.audit_event (account_id, actor, action, prev_event_id, payload_json)
  VALUES (found_account_id, 'google_oauth', 'authz'::public.audit_action, previous_event_id,
          '{"provider":"google","event":"login"}'::jsonb);
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
  JOIN public.account_membership AS m
    ON m.account_id = s.account_id
   AND m.user_id = s.user_id
   AND m.status = 'active'::public.membership_status
  WHERE s.token_hash = input_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > clock_timestamp()
    AND a.status = 'active'::public.account_status
    AND a.deleted_at IS NULL;
END;
$$;

-- Keep invitation acceptance on the same per-account audit chain as every
-- other authorization mutation. The state-row lock serializes writers and
-- the previous event id preserves the tamper-evident predecessor link.
CREATE OR REPLACE FUNCTION public.auth_accept_invitation(
  p_session_hash text,
  p_token_hash text,
  p_replacement_session_hash text,
  p_replacement_expires_at timestamptz
)
RETURNS TABLE (account_id uuid, user_id uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_account_id uuid;
  current_user_id uuid;
  found_session_id uuid;
  invitation_account_id uuid;
  invitation_role public.membership_role;
  invitation_status_value public.invitation_status;
  invitation_expires_at timestamptz;
  accepted_for_user_id uuid;
  target_account_status public.account_status;
  existing_membership_status public.membership_status;
  previous_event_id uuid;
BEGIN
  IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_replacement_session_hash IS NULL OR p_replacement_session_hash !~ '^[0-9a-f]{64}$'
     OR p_session_hash = p_replacement_session_hash
     OR p_replacement_expires_at IS NULL
     OR p_replacement_expires_at <= clock_timestamp()
     OR p_replacement_expires_at > clock_timestamp() + interval '31 days' THEN
    RETURN;
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT s.account_id, s.user_id, s.id
  INTO current_account_id, current_user_id, found_session_id
  FROM public.session AS s
  JOIN public.account AS a ON a.id = s.account_id
  JOIN public.account_membership AS current_membership
    ON current_membership.account_id = s.account_id
   AND current_membership.user_id = s.user_id
   AND current_membership.status = 'active'::public.membership_status
  WHERE s.token_hash = p_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > clock_timestamp()
    AND a.status = 'active'::public.account_status
    AND a.deleted_at IS NULL
  FOR UPDATE OF s;
  IF found_session_id IS NULL THEN RETURN; END IF;

  SELECT i.account_id, i.proposed_role, i.status, i.expires_at,
         i.accepted_by_user_id, a.status
  INTO invitation_account_id, invitation_role, invitation_status_value,
       invitation_expires_at, accepted_for_user_id, target_account_status
  FROM public.account_invitation AS i
  JOIN public.account AS a ON a.id = i.account_id
  WHERE i.token_hash = p_token_hash
  FOR UPDATE OF i;
  IF invitation_account_id IS NULL
     OR target_account_status <> 'active'::public.account_status THEN
    RETURN;
  END IF;
  IF invitation_status_value = 'accepted'::public.invitation_status
     AND accepted_for_user_id = current_user_id THEN
    account_id := invitation_account_id;
    user_id := current_user_id;
    session_id := found_session_id;
    RETURN NEXT;
    RETURN;
  ELSIF invitation_status_value <> 'pending'::public.invitation_status THEN
    RETURN;
  ELSIF invitation_expires_at <= clock_timestamp() THEN
    RETURN;
  ELSE
    SELECT m.status INTO existing_membership_status
    FROM public.account_membership AS m
    WHERE m.account_id = invitation_account_id AND m.user_id = current_user_id
    FOR UPDATE;
    IF existing_membership_status = 'suspended'::public.membership_status THEN
      RETURN;
    END IF;
    INSERT INTO public.account_membership (account_id, user_id, role, status)
    VALUES (invitation_account_id, current_user_id, invitation_role,
            'active'::public.membership_status)
    ON CONFLICT ON CONSTRAINT account_membership_account_user_unique DO NOTHING;
    UPDATE public.account_membership AS existing_membership
    SET role = invitation_role, status = 'active'::public.membership_status,
        removed_at = NULL, updated_at = clock_timestamp()
    WHERE existing_membership.account_id = invitation_account_id
      AND existing_membership.user_id = current_user_id
      AND existing_membership.status = 'removed'::public.membership_status;
    UPDATE public.account_invitation
    SET status = 'accepted'::public.invitation_status,
        accepted_at = clock_timestamp(), accepted_by_user_id = current_user_id
    WHERE token_hash = p_token_hash;

    INSERT INTO public.audit_account_state (account_id)
    VALUES (invitation_account_id)
    ON CONFLICT DO NOTHING;
    PERFORM 1
    FROM public.audit_account_state AS state
    WHERE state.account_id = invitation_account_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'audit account state unavailable'; END IF;
    SELECT event.id INTO previous_event_id
    FROM public.audit_event AS event
    WHERE event.account_id = invitation_account_id
    ORDER BY event.chain_seq DESC
    LIMIT 1;
    INSERT INTO public.audit_event (account_id, actor, action, prev_event_id, payload_json)
    VALUES (
      invitation_account_id,
      current_user_id::text,
      'authz'::public.audit_action,
      previous_event_id,
      jsonb_build_object('event', 'invitation_accepted',
                         'membership_user_id', current_user_id)
    );
  END IF;

  UPDATE public.session
  SET account_id = invitation_account_id,
      token_hash = p_replacement_session_hash,
      rotated_at = clock_timestamp(),
      expires_at = p_replacement_expires_at
  WHERE id = found_session_id;
  account_id := invitation_account_id;
  user_id := current_user_id;
  session_id := found_session_id;
  RETURN NEXT;
END;
$$;

-- Fixed-purpose owner/admin mutation. The caller supplies at most one role and
-- status change; null preserves that field. Removing a membership revokes its
-- sessions in the same transaction before returning the redacted row.
CREATE OR REPLACE FUNCTION public.auth_update_membership(
  p_session_hash text,
  p_account_id uuid,
  p_target_user_id uuid,
  p_new_role public.membership_role,
  p_new_status public.membership_status
)
RETURNS TABLE (
  id uuid,
  account_id uuid,
  user_id uuid,
  role public.membership_role,
  status public.membership_status,
  invited_by_user_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  removed_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_user_id uuid;
  actor_session_id uuid;
  actor_role public.membership_role;
  target_role public.membership_role;
  target_status public.membership_status;
  active_owner_count integer;
  previous_event_id uuid;
BEGIN
  IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_account_id IS NULL OR p_target_user_id IS NULL
     OR (p_new_role IS NULL AND p_new_status IS NULL) THEN
    RETURN;
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT s.user_id, s.id, actor_membership.role
  INTO actor_user_id, actor_session_id, actor_role
  FROM public.session AS s
  JOIN public.account AS a ON a.id = s.account_id
  JOIN public.account_membership AS actor_membership
    ON actor_membership.account_id = s.account_id
   AND actor_membership.user_id = s.user_id
   AND actor_membership.status = 'active'::public.membership_status
   AND actor_membership.role IN ('owner'::public.membership_role, 'admin'::public.membership_role)
  WHERE s.token_hash = p_session_hash
    AND s.account_id = p_account_id
    AND s.revoked_at IS NULL
    AND s.expires_at > clock_timestamp()
    AND a.status = 'active'::public.account_status
    AND a.deleted_at IS NULL
  FOR UPDATE OF s;
  IF actor_session_id IS NULL THEN RETURN; END IF;

  SELECT m.role, m.status
  INTO target_role, target_status
  FROM public.account_membership AS m
  WHERE m.account_id = p_account_id AND m.user_id = p_target_user_id
  FOR UPDATE;
  IF target_role IS NULL THEN RETURN; END IF;
  IF actor_role <> 'owner'::public.membership_role
     AND (target_role = 'owner'::public.membership_role
          OR p_new_role = 'owner'::public.membership_role) THEN
    RETURN;
  END IF;

  IF target_role = 'owner'::public.membership_role
     AND (COALESCE(p_new_role, target_role) <> 'owner'::public.membership_role
          OR COALESCE(p_new_status, target_status) <> 'active'::public.membership_status) THEN
    PERFORM 1
    FROM public.account_membership AS owner_lock
    WHERE owner_lock.account_id = p_account_id
      AND owner_lock.role = 'owner'::public.membership_role
      AND owner_lock.status = 'active'::public.membership_status
    FOR UPDATE;
    SELECT count(*)::integer
    INTO active_owner_count
    FROM public.account_membership AS owner_count
    WHERE owner_count.account_id = p_account_id
      AND owner_count.role = 'owner'::public.membership_role
      AND owner_count.status = 'active'::public.membership_status;
    IF active_owner_count <= 1 THEN RETURN; END IF;
  END IF;

  UPDATE public.account_membership AS m
  SET role = COALESCE(p_new_role, m.role),
      status = COALESCE(p_new_status, m.status),
      removed_at = CASE
        WHEN COALESCE(p_new_status, m.status) = 'removed'::public.membership_status
          THEN COALESCE(m.removed_at, clock_timestamp())
        ELSE NULL
      END,
      updated_at = clock_timestamp()
  WHERE m.account_id = p_account_id AND m.user_id = p_target_user_id;

  IF COALESCE(p_new_status, target_status) = 'removed'::public.membership_status THEN
    UPDATE public.session AS s
    SET revoked_at = COALESCE(s.revoked_at, clock_timestamp())
    WHERE s.account_id = p_account_id AND s.user_id = p_target_user_id;
  END IF;

  INSERT INTO public.audit_account_state (account_id)
  VALUES (p_account_id)
  ON CONFLICT DO NOTHING;
  PERFORM 1
  FROM public.audit_account_state AS state
  WHERE state.account_id = p_account_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'audit account state unavailable'; END IF;
  SELECT event.id INTO previous_event_id
  FROM public.audit_event AS event
  WHERE event.account_id = p_account_id
  ORDER BY event.chain_seq DESC
  LIMIT 1;
  INSERT INTO public.audit_event (account_id, actor, action, prev_event_id, payload_json)
  VALUES (
    p_account_id,
    actor_user_id::text,
    'authz'::public.audit_action,
    previous_event_id,
    jsonb_build_object(
      'event', CASE WHEN COALESCE(p_new_status, target_status) = 'removed'::public.membership_status
                    THEN 'membership_removed' ELSE 'membership_updated' END,
      'membership_user_id', p_target_user_id
    )
  );

  RETURN QUERY
  SELECT m.id, m.account_id, m.user_id, m.role, m.status, m.invited_by_user_id,
         m.created_at, m.updated_at, m.removed_at
  FROM public.account_membership AS m
  WHERE m.account_id = p_account_id AND m.user_id = p_target_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.auth_resolve_session(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_update_membership(text, uuid, uuid, public.membership_role, public.membership_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_resolve_session(text) TO auth_bootstrap;
GRANT EXECUTE ON FUNCTION public.auth_update_membership(text, uuid, uuid, public.membership_role, public.membership_status) TO auth_bootstrap;
ALTER FUNCTION public.auth_resolve_session(text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.auth_update_membership(text, uuid, uuid, public.membership_role, public.membership_status) OWNER TO CURRENT_USER;
