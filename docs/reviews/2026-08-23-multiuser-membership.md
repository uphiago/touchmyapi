# Multi-user membership expand-contract review

**Status:** T079 complete on feat/foundation-phase2; T080 remains the
aggregate membership acceptance gate.

## Migration journal and schema evidence

- The Drizzle journal was inspected before the membership migrations. The
  applied sequence is "0011_multiuser_membership" through
  "0017_multiuser_rls_references"; replaying the migration command on a fresh
  _test database is a no-op after the sequence is applied.
- user.account_id, user.provider_subject, and the unique
  user_account_id_unique constraint remain present and non-null. This is an
  intentional expand-phase compatibility boundary, not a second identity
  authority.
- account_membership(account_id,user_id) is the additive authorization source.
  Membership identity references use immutable user.id; session and
  attestation rows additionally use composite tenant references.
- Migration 0011 backfills one active owner membership for each legacy
  user/account row with INSERT ... SELECT u.account_id, u.id. The account and
  user foreign keys make the orphan set empty on a valid database. If a legacy
  export ever contains an orphan, it must be handled by an explicit support
  migration; it is never reconciled by email.

## Dual-read and cutover sequence

1. During expand, authentication keeps the legacy user row and creates the
   additive owner membership. auth_resolve_session, auth_list_accounts, and
   auth_switch_account require an active membership while still reading the
   legacy identity table.
2. The first authenticated request resolves the active account from
   session.account_id; account switching rotates the opaque session hash and
   invalidates the previous hash. No browser tenant selector is authoritative.
3. New invitation and membership mutations read/write membership only and
   append to the account audit chain. Session and attestation composite FKs
   prevent a tenant-bound actor from crossing accounts.
4. Cutover is complete only after the membership/RLS acceptance gate has held
   in staging and production observation. A later migration may then make
   membership the sole authorization read path.
5. Removal of user.account_id and user_account_id_unique is a separate,
   reviewed migration after all legacy readers, exports, repair scripts, and
   rollback procedures are removed. It is explicitly out of T079/T080.

## Rollback and quarantine

Before cutover, rollback disables new membership routes and returns reads to
the legacy path while preserving additive memberships, invitation hashes, and
audit history. After cutover, rollback is forward-only: revoke newly issued
sessions and correct access through explicit membership mutations. Audit rows
and queue history are never deleted.

There is no automatic orphan repair. The focused review test asserts zero
orphan membership rows and checks the migration explicit-support-migration
and no-email-matching guard. Any quarantined export row requires a ticketed
support migration with an immutable identity decision.

## Focused evidence

RUN_DB_TESTS=1 DATABASE_URL=..._test
  bun run test:integration -- --maxWorkers=1 multiuser-migration

Result: **4 tests passed** on the freshly migrated
touchmyapi_t079_review_test database. The suite covers:

- legacy column/unique preservation;
- owner membership and session-account binding for a legacy login;
- dual-read account listing plus explicit session rotation and old-hash
  invalidation;
- empty orphan set and explicit quarantine/no-email migration guard.

T080 must still run the complete unit, contract, integration, isolation,
typecheck, lint, format, web-build, Compose, and local smoke gates before the
membership phase is accepted.
