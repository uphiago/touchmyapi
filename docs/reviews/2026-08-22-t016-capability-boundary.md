# T016 tenant capability boundary review

**Commit range:** `21f830e..ca8483f`  
**Status:** Accepted  
**Scope:** T016 only; T017–T021 remain pending.

## Decision

The arbitrary `TenantConnection.unsafe(string)` callback was removed. `@touchmyapi/db` now exposes `createTenantDatabase`, an opaque `TenantDatabase`, `withTenant`, `RuntimeRole`, and `TenantContext`; it does not expose a raw postgres.js connection, generic query API, or internal subpath. Internal repository operations use a transaction-bound `WeakMap` executor, with context account and lifecycle state unavailable to callbacks.

`account.readCurrent()` is the fixed read capability. `account.setIaEnabled(boolean)` exists only for `api_rls`, binds the context account, requires an active non-deleted account, and fails closed otherwise. `worker_rls` and `reporting_rls` do not receive a setter, including after an in-transaction `GRANT UPDATE` to the worker.

## Review gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Specification review | Ready: Yes | Public/raw boundary, fixed operations, context expiry, role matrix, lifecycle, and RLS test ownership reviewed |
| Adversarial quality review | Ready: Yes | Table/function and worker-UPDATE late-grant paths, forged/reused handles, role mutation, inactive accounts, concurrency, cleanup, and package export map reviewed |

The quality review noted a non-blocking teardown hygiene improvement: if a probe `REVOKE` fails, its `DROP` is not attempted. It does not affect runtime behavior or the accepted security boundary.

## Fresh verification

On Bun 1.4.0 and PostgreSQL 16, using the separately migrated loopback database `touchmyapi_t016_quality_test`:

- `RUN_DB_TESTS=1 ... bun run test:integration -- tenant-session`: 25/25 passed.
- `RUN_DB_TESTS=1 ... bun run test:isolation --maxWorkers=1`: 20/20 passed.
- `bun run typecheck`, `bun run lint`, `bun run format`, and `git diff --check`: passed.

Database suites were run sequentially. A previously reused test database still contains interrupted-run fixture residue and is not used as evidence for this acceptance.

## Next task

T017 must add the redacted append-only audit chain through a narrow transaction-owned capability. It must not reintroduce a generic query export or an arbitrary advisory-lock surface.
