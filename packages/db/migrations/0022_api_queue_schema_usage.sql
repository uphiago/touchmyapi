-- api_rls already has EXECUTE only on the two fixed-purpose enqueue functions.
-- PostgreSQL also requires schema USAGE to resolve those explicitly granted routines.
GRANT USAGE ON SCHEMA app_private TO api_rls;
