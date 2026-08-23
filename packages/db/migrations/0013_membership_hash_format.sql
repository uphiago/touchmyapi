-- Keep the token-hash invariant in the declarative Drizzle schema and make
-- this expand migration safe for databases that received the earlier custom
-- 0011 check before the constraint was promoted to its own migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS c
    WHERE c.conrelid = 'public.account_invitation'::regclass
      AND c.conname = 'account_invitation_token_hash_format'
  ) THEN
    ALTER TABLE public.account_invitation
      ADD CONSTRAINT account_invitation_token_hash_format
      CHECK (token_hash ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;
