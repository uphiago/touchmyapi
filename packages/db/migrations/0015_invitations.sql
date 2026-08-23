-- Custom SQL migration file, put your code below! --
-- Invitation creation/acceptance accepts only a SHA-256 token hash. The raw
-- 256-bit value is generated and delivered by the application boundary and is
-- never passed to PostgreSQL, persisted, logged, or written to audit payloads.
DROP FUNCTION IF EXISTS public.auth_create_invitation(uuid, uuid, citext, public.membership_role, text, timestamptz);
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
  IF inviter_id IS NULL THEN RETURN; END IF;
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
  invitation_id := created_id;
  RETURN NEXT;
END;
$$;

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

  SELECT i.account_id, i.proposed_role, i.status, i.expires_at, i.accepted_by_user_id, a.status
  INTO invitation_account_id, invitation_role, invitation_status_value,
       invitation_expires_at, accepted_for_user_id, target_account_status
  FROM public.account_invitation AS i
  JOIN public.account AS a ON a.id = i.account_id
  WHERE i.token_hash = p_token_hash
  FOR UPDATE OF i;
  IF invitation_account_id IS NULL OR target_account_status <> 'active'::public.account_status THEN
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
    INSERT INTO public.account_membership (account_id, user_id, role, status)
    VALUES (invitation_account_id, current_user_id, invitation_role, 'active'::public.membership_status)
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
    INSERT INTO public.audit_event (account_id, actor, action, payload_json)
    VALUES (
      invitation_account_id,
      current_user_id::text,
      'authz'::public.audit_action,
      jsonb_build_object('event', 'invitation_accepted', 'membership_user_id', current_user_id)
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

REVOKE EXECUTE ON FUNCTION public.auth_create_invitation(text, uuid, citext, public.membership_role, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_accept_invitation(text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_create_invitation(text, uuid, citext, public.membership_role, text, timestamptz) TO auth_bootstrap;
GRANT EXECUTE ON FUNCTION public.auth_accept_invitation(text, text, text, timestamptz) TO auth_bootstrap;
ALTER FUNCTION public.auth_create_invitation(text, uuid, citext, public.membership_role, text, timestamptz) OWNER TO CURRENT_USER;
ALTER FUNCTION public.auth_accept_invitation(text, text, text, timestamptz) OWNER TO CURRENT_USER;
