# Database scripts

`migrate.ts` is the foundation migration entry point. It fails closed with exit
code 1 and a generic stderr message when `DATABASE_URL` is absent, so a clean
checkout never silently skips a requested migration.

Place deterministic development seed scripts in this directory. The tenant
schema, RLS roles, and any seed data are intentionally not implemented yet.
Foundation migrations and RLS safeguards will be added in the next tasks of
this increment before application data is created.
