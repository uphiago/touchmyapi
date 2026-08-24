-- Display email is contact metadata only; immutable provider_subject remains identity authority.
DROP FUNCTION public.auth_list_memberships(text, uuid);
CREATE FUNCTION public.auth_list_memberships(
  p_session_hash text,
  p_account_id uuid
)
RETURNS TABLE (
  id uuid,
  account_id uuid,
  user_id uuid,
  email citext,
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
  SELECT membership.id, membership.account_id, membership.user_id, member.email,
    membership.role, membership.status, membership.invited_by_user_id,
    membership.created_at, membership.updated_at, membership.removed_at
  FROM public.account_membership AS membership
  JOIN public."user" AS member
    ON member.account_id = membership.account_id AND member.id = membership.user_id
  WHERE membership.account_id = p_account_id
  ORDER BY membership.created_at, membership.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.auth_list_memberships(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_list_memberships(text, uuid) TO auth_bootstrap;
ALTER FUNCTION public.auth_list_memberships(text, uuid) OWNER TO CURRENT_USER;
