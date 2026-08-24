-- Role changes are security-sensitive: successful changes revoke every target
-- session in the same transaction. Removal was already handled by 0016.
CREATE OR REPLACE FUNCTION public.auth_update_membership_secure(
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
BEGIN
  RETURN QUERY
  SELECT updated.id, updated.account_id, updated.user_id, updated.role,
    updated.status, updated.invited_by_user_id, updated.created_at,
    updated.updated_at, updated.removed_at
  FROM public.auth_update_membership(
    p_session_hash, p_account_id, p_target_user_id, p_new_role, p_new_status
  ) AS updated;
  IF FOUND AND p_new_role IS NOT NULL THEN
    UPDATE public.session AS target_session
    SET revoked_at = COALESCE(target_session.revoked_at, clock_timestamp())
    WHERE target_session.account_id = p_account_id
      AND target_session.user_id = p_target_user_id;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.auth_update_membership_secure(text, uuid, uuid, public.membership_role, public.membership_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_update_membership_secure(text, uuid, uuid, public.membership_role, public.membership_status) TO auth_bootstrap;
ALTER FUNCTION public.auth_update_membership_secure(text, uuid, uuid, public.membership_role, public.membership_status) OWNER TO CURRENT_USER;
