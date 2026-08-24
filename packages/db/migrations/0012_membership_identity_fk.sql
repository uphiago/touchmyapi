-- Expand-phase identity FK correction. The generated 0011 migration initially
-- emitted composite account/user references, but those prevent one immutable
-- global user from joining a second account while legacy user.account_id is
-- still unique. Keep the tenant key explicit and reference user.id directly.
-- This block is safe both through the Drizzle journal and when replayed as raw
-- SQL: a correct simple FK is left untouched.
DO $$
DECLARE
  item record;
  definition text;
BEGIN
  FOR item IN
    SELECT *
    FROM (VALUES
      ('account_invitation', 'account_invitation_invited_by_user_fk', 'invited_by_user_id'),
      ('account_invitation', 'account_invitation_accepted_by_user_fk', 'accepted_by_user_id'),
      ('account_membership', 'account_membership_user_fk', 'user_id'),
      ('account_membership', 'account_membership_invited_by_user_fk', 'invited_by_user_id')
    ) AS references_to_fix(table_name, constraint_name, column_name)
  LOOP
    SELECT pg_get_constraintdef(c.oid)
    INTO definition
    FROM pg_constraint AS c
    JOIN pg_class AS t ON t.oid = c.conrelid
    JOIN pg_namespace AS n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = item.table_name
      AND c.conname = item.constraint_name;

    IF definition IS NOT NULL AND definition ILIKE '%account_id%' THEN
      EXECUTE format(
        'ALTER TABLE public.%I DROP CONSTRAINT %I',
        item.table_name,
        item.constraint_name
      );
      definition := NULL;
    END IF;

    IF definition IS NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public."user"(id) ON DELETE no action ON UPDATE no action',
        item.table_name,
        item.constraint_name,
        item.column_name
      );
    END IF;
  END LOOP;
END
$$;
