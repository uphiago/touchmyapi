ALTER TABLE public.session ADD COLUMN IF NOT EXISTS family_id uuid;
UPDATE public.session SET family_id = gen_random_uuid() WHERE family_id IS NULL;
ALTER TABLE public.session ALTER COLUMN family_id SET DEFAULT gen_random_uuid();
ALTER TABLE public.session ALTER COLUMN family_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS session_family_id_idx ON public.session USING btree (family_id);
