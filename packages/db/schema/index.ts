/**
 * Drizzle schema entry point.
 *
 * The tenant-scoped schema and RLS policies are intentionally introduced in
 * Phase 2. Keeping this module present lets Drizzle resolve the schema path
 * without declaring any tables before those safeguards exist.
 */
export {};
