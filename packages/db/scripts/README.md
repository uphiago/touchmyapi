# Database scripts

`migrate.ts` is the Phase 1 migration entry point. It exits successfully when
`DATABASE_URL` is absent, so a clean checkout has no database side effects.

Place deterministic development seed scripts in this directory. The tenant
schema, RLS roles, and any seed data are intentionally deferred to Phase 2 so
this setup phase cannot create data without the required isolation safeguards.
