-- Phase 2A membership expand migration. Legacy user.account_id remains
-- authoritative during expand; membership becomes the additive authorization
-- boundary and is backfilled without email matching.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'membership_role') THEN
    CREATE TYPE public.membership_role AS ENUM ('owner', 'admin', 'operator', 'viewer', 'billing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'membership_status') THEN
    CREATE TYPE public.membership_status AS ENUM ('active', 'suspended', 'removed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'invitation_status') THEN
    CREATE TYPE public.invitation_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.account_membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role public.membership_role DEFAULT 'viewer' NOT NULL,
  status public.membership_status DEFAULT 'active' NOT NULL,
  invited_by_user_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  removed_at timestamptz,
  CONSTRAINT account_membership_account_user_unique UNIQUE (account_id, user_id),
  CONSTRAINT account_membership_account_id_id_unique UNIQUE (account_id, id),
  CONSTRAINT account_membership_account_fk FOREIGN KEY (account_id)
    REFERENCES public.account(id),
  CONSTRAINT account_membership_user_fk FOREIGN KEY (account_id, user_id)
    REFERENCES public."user"(account_id, id),
  CONSTRAINT account_membership_invited_by_user_fk FOREIGN KEY (account_id, invited_by_user_id)
    REFERENCES public."user"(account_id, id)
);

CREATE INDEX IF NOT EXISTS account_membership_account_status_idx
  ON public.account_membership (account_id, status);

CREATE TABLE IF NOT EXISTS public.account_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  token_hash text NOT NULL,
  email public.citext NOT NULL,
  proposed_role public.membership_role NOT NULL,
  status public.invitation_status DEFAULT 'pending' NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  invited_by_user_id uuid NOT NULL,
  accepted_by_user_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT account_invitation_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT account_invitation_account_id_id_unique UNIQUE (account_id, id),
  CONSTRAINT account_invitation_account_fk FOREIGN KEY (account_id)
    REFERENCES public.account(id),
  CONSTRAINT account_invitation_invited_by_user_fk FOREIGN KEY (account_id, invited_by_user_id)
    REFERENCES public."user"(account_id, id),
  CONSTRAINT account_invitation_accepted_by_user_fk FOREIGN KEY (account_id, accepted_by_user_id)
    REFERENCES public."user"(account_id, id)
);

CREATE INDEX IF NOT EXISTS account_invitation_account_status_idx
  ON public.account_invitation (account_id, status);

-- Existing legacy rows are one owner membership per account. The user table's
-- account FK makes orphan rows impossible; any future quarantine must be an
-- explicit support migration and cannot use email matching.
INSERT INTO public.account_membership (account_id, user_id, role, status)
SELECT u.account_id, u.id, 'owner', 'active'
FROM public."user" AS u
WHERE NOT EXISTS (
  SELECT 1
  FROM public.account_membership AS m
  WHERE m.account_id = u.account_id AND m.user_id = u.id
);

-- Membership rows are tenant-scoped from their first release. Runtime roles
-- receive only the app.tenant policies below; no PUBLIC policy or table grant
-- is created here, so an omitted tenant context remains default-deny.
ALTER TABLE public.account_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_membership FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_membership_api_rls_tenant ON public.account_membership;
CREATE POLICY account_membership_api_rls_tenant
  ON public.account_membership FOR ALL TO api_rls
  USING (public.rls_tenant_matches(account_id))
  WITH CHECK (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS account_membership_worker_rls_tenant ON public.account_membership;
CREATE POLICY account_membership_worker_rls_tenant
  ON public.account_membership FOR ALL TO worker_rls
  USING (public.rls_tenant_matches(account_id))
  WITH CHECK (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS account_membership_reporting_rls_tenant ON public.account_membership;
CREATE POLICY account_membership_reporting_rls_tenant
  ON public.account_membership FOR SELECT TO reporting_rls
  USING (public.rls_tenant_matches(account_id));

ALTER TABLE public.account_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_invitation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_invitation_api_rls_tenant ON public.account_invitation;
CREATE POLICY account_invitation_api_rls_tenant
  ON public.account_invitation FOR ALL TO api_rls
  USING (public.rls_tenant_matches(account_id))
  WITH CHECK (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS account_invitation_worker_rls_tenant ON public.account_invitation;
CREATE POLICY account_invitation_worker_rls_tenant
  ON public.account_invitation FOR ALL TO worker_rls
  USING (public.rls_tenant_matches(account_id))
  WITH CHECK (public.rls_tenant_matches(account_id));
DROP POLICY IF EXISTS account_invitation_reporting_rls_tenant ON public.account_invitation;
CREATE POLICY account_invitation_reporting_rls_tenant
  ON public.account_invitation FOR SELECT TO reporting_rls
  USING (public.rls_tenant_matches(account_id));
