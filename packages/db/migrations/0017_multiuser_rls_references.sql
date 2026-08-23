-- Bind tenant-scoped actors to the explicit membership boundary. The legacy
-- user.account_id identity FK remains during expand; these composite keys make
-- session.account_id and attestation.account_id authoritative for references.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.session'::regclass
      AND conname = 'session_membership_fk'
  ) THEN
    ALTER TABLE public.session
      ADD CONSTRAINT session_membership_fk
      FOREIGN KEY (account_id, user_id)
      REFERENCES public.account_membership (account_id, user_id)
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.authorization_attestation'::regclass
      AND conname = 'authorization_attestation_user_fk'
  ) THEN
    ALTER TABLE public.authorization_attestation
      DROP CONSTRAINT authorization_attestation_user_fk;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.authorization_attestation'::regclass
      AND conname = 'authorization_attestation_membership_fk'
  ) THEN
    ALTER TABLE public.authorization_attestation
      ADD CONSTRAINT authorization_attestation_membership_fk
      FOREIGN KEY (account_id, user_id)
      REFERENCES public.account_membership (account_id, user_id)
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END
$$;

-- Membership reads are tenant-scoped. Invitation token hashes are deliberately
-- excluded from runtime-role column grants; creation/acceptance stays inside
-- fixed SECURITY DEFINER auth functions.
GRANT SELECT ON TABLE public.account_membership TO api_rls;
GRANT SELECT (
  id, account_id, email, proposed_role, status, expires_at, accepted_at,
  invited_by_user_id, accepted_by_user_id, created_at
) ON TABLE public.account_invitation TO api_rls;
