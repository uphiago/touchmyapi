-- Fixed-purpose, redacted membership directory functions for auth_connector.
CREATE OR REPLACE FUNCTION public.auth_list_memberships(
  p_session_hash text,
  p_account_id uuid
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
BEGIN
  IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$'
     OR p_account_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  IF NOT EXISTS (
    SELECT 1
    FROM public.session AS session
    JOIN public.account AS account ON account.id = session.account_id
    JOIN public.account_membership AS actor
      ON actor.account_id = session.account_id
     AND actor.user_id = session.user_id
     AND actor.status = 'active'::public.membership_status
    WHERE session.token_hash = p_session_hash
      AND session.account_id = p_account_id
      AND session.revoked_at IS NULL
      AND session.expires_at > clock_timestamp()
      AND account.status = 'active'::public.account_status
      AND account.deleted_at IS NULL
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT membership.id, membership.account_id, membership.user_id,
    membership.role, membership.status, membership.invited_by_user_id,
    membership.created_at, membership.updated_at, membership.removed_at
  FROM public.account_membership AS membership
  WHERE membership.account_id = p_account_id
  ORDER BY membership.created_at, membership.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_create_invitation_snapshot(
  p_session_hash text,
  p_account_id uuid,
  p_email citext,
  p_role public.membership_role,
  p_token_hash text,
  p_expires_at timestamptz
)
RETURNS TABLE (
  id uuid,
  account_id uuid,
  email citext,
  proposed_role public.membership_role,
  status public.invitation_status,
  expires_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz,
  invited_by_user_id uuid,
  accepted_by_user_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  created_id uuid;
BEGIN
  SELECT invitation_id INTO created_id
  FROM public.auth_create_invitation(
    p_session_hash, p_account_id, p_email, p_role, p_token_hash, p_expires_at
  );
  IF created_id IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT invitation.id, invitation.account_id, invitation.email,
    invitation.proposed_role, invitation.status, invitation.expires_at,
    invitation.accepted_at, invitation.created_at,
    invitation.invited_by_user_id, invitation.accepted_by_user_id
  FROM public.account_invitation AS invitation
  WHERE invitation.id = created_id AND invitation.account_id = p_account_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.auth_list_memberships(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_create_invitation_snapshot(text, uuid, citext, public.membership_role, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_list_memberships(text, uuid) TO auth_bootstrap;
GRANT EXECUTE ON FUNCTION public.auth_create_invitation_snapshot(text, uuid, citext, public.membership_role, text, timestamptz) TO auth_bootstrap;
ALTER FUNCTION public.auth_list_memberships(text, uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION public.auth_create_invitation_snapshot(text, uuid, citext, public.membership_role, text, timestamptz) OWNER TO CURRENT_USER;
