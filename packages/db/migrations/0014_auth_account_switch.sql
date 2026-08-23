-- A session's immutable identity is global; account_id is the active tenant
-- selected through membership. The legacy composite FK would reject a valid
-- account switch while user.account_id remains unique during expand.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.session'::regclass AND conname = 'session_account_user_fk'
  ) THEN
    ALTER TABLE public.session DROP CONSTRAINT session_account_user_fk;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.session'::regclass AND conname = 'session_user_fk'
  ) THEN
    ALTER TABLE public.session
      ADD CONSTRAINT session_user_fk FOREIGN KEY (user_id)
      REFERENCES public."user"(id) ON DELETE no action ON UPDATE no action;
  END IF;
END
$$;

-- Auth bootstrap is the only fixed-signature path allowed to inspect all
-- memberships before a tenant role has been selected. It is owner-checked by
-- rls_bootstrap_context and is not a generic PUBLIC fallback.
DROP POLICY IF EXISTS account_membership_bootstrap ON public.account_membership;
CREATE POLICY account_membership_bootstrap
  ON public.account_membership FOR ALL TO PUBLIC
  USING (public.rls_bootstrap_context())
  WITH CHECK (public.rls_bootstrap_context());

CREATE OR REPLACE FUNCTION public.auth_list_accounts(input_session_hash text)
RETURNS TABLE (
  account_id uuid,
  role public.membership_role,
  status public.membership_status,
  active boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_account_id uuid;
  current_user_id uuid;
BEGIN
  IF input_session_hash IS NULL OR input_session_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT s.account_id, s.user_id
  INTO current_account_id, current_user_id
  FROM public.session AS s
  JOIN public.account AS a ON a.id = s.account_id
  WHERE s.token_hash = input_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > clock_timestamp()
    AND a.status = 'active'::public.account_status
    AND a.deleted_at IS NULL;
  IF current_user_id IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT m.account_id, m.role, m.status, (m.account_id = current_account_id)
  FROM public.account_membership AS m
  JOIN public.account AS a ON a.id = m.account_id
  WHERE m.user_id = current_user_id
    AND a.status = 'active'::public.account_status
    AND a.deleted_at IS NULL
  ORDER BY m.account_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_switch_account(
  current_session_hash text,
  target_account_id uuid,
  replacement_session_hash text,
  replacement_expires_at timestamptz
)
RETURNS TABLE (account_id uuid, user_id uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  found_session_id uuid;
  found_user_id uuid;
  found_account_id uuid;
  membership_ok boolean;
BEGIN
  IF current_session_hash IS NULL OR current_session_hash !~ '^[0-9a-f]{64}$'
     OR replacement_session_hash IS NULL OR replacement_session_hash !~ '^[0-9a-f]{64}$'
     OR current_session_hash = replacement_session_hash
     OR target_account_id IS NULL
     OR replacement_expires_at IS NULL
     OR replacement_expires_at <= clock_timestamp()
     OR replacement_expires_at > clock_timestamp() + interval '31 days' THEN
    RETURN;
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT s.id, s.user_id, s.account_id
  INTO found_session_id, found_user_id, found_account_id
  FROM public.session AS s
  JOIN public.account AS a ON a.id = s.account_id
  WHERE s.token_hash = current_session_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > clock_timestamp()
    AND a.status = 'active'::public.account_status
    AND a.deleted_at IS NULL
  FOR UPDATE OF s;
  IF found_session_id IS NULL THEN RETURN; END IF;

  SELECT true INTO membership_ok
  FROM public.account_membership AS m
  JOIN public.account AS a ON a.id = m.account_id
  WHERE m.account_id = target_account_id
    AND m.user_id = found_user_id
    AND m.status = 'active'::public.membership_status
    AND a.status = 'active'::public.account_status
    AND a.deleted_at IS NULL
  FOR SHARE;
  IF membership_ok IS DISTINCT FROM true THEN RETURN; END IF;

  UPDATE public.session
  SET account_id = target_account_id,
      token_hash = replacement_session_hash,
      rotated_at = clock_timestamp(),
      expires_at = replacement_expires_at
  WHERE id = found_session_id;
  account_id := target_account_id;
  user_id := found_user_id;
  session_id := found_session_id;
  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.auth_list_accounts(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_switch_account(text, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_list_accounts(text) TO auth_bootstrap;
GRANT EXECUTE ON FUNCTION public.auth_switch_account(text, uuid, text, timestamptz) TO auth_bootstrap;
ALTER FUNCTION public.auth_list_accounts(text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.auth_switch_account(text, uuid, text, timestamptz) OWNER TO CURRENT_USER;
