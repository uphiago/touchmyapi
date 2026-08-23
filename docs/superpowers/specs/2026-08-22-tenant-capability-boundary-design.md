# Tenant capability boundary design

**Date:** 2026-08-22  
**Status:** Approved for the resumed T016 implementation  
**Scope:** Replace the provisional arbitrary tenant-SQL callback surface. This design does not add assessment, queue, billing, runner, target-network, AI, report, membership, or admin behavior.

## Problem

`withTenant` already reserves one PostgreSQL backend, starts a transaction before role inspection, sets `app.tenant` and a literal `SET LOCAL ROLE`, validates the connector, then clears and releases the backend. Its public callback nevertheless receives `unsafe(string)`. A migration administrator can grant a new function or table privilege after the post-switch inspection and before that arbitrary query executes. Rechecking the catalog cannot close that time-of-check/time-of-use race.

## Alternatives

### A. Extend the SQL firewall

Keep `unsafe(string)` and block additional grammar, built-ins, or catalog checks. This is rejected: every denylist is incomplete and a live ACL change still widens a generic query interface.

### B. Closed TypeScript repositories and transaction capabilities (selected)

The callback receives an opaque `TenantContext<R>` containing only typed, role-appropriate capability methods. Each method owns a literal SQL statement and bind parameters; no caller supplies SQL, table names, columns, function names, or `account_id`. A private module, excluded from the `@touchmyapi/db` export map, owns the active reserved-backend executor through a `WeakMap` keyed by the context. Repository modules use that executor only for their fixed statements.

This is the smallest boundary that removes the live-grant class while retaining the existing runtime roles/RLS and gives T017 a transaction-bound audit capability.

### C. Fixed `SECURITY DEFINER` PostgreSQL function for every repository operation

This would provide a stronger database-only interface, but it requires a broad new set of function owners, grants, migrations, and role redesign before Foundation has its first domain operation. It remains appropriate for queue control in Phase 2A, but is rejected for T016 as disproportionate expansion.

## Selected interface and lifecycle

`withTenant(connection, accountId, role, callback)` keeps its existing lifecycle:

1. reserve one backend and issue `BEGIN`;
2. validate the dedicated connector on that backend;
3. use `set_config('app.tenant', accountId, true)` and a literal `SET LOCAL ROLE`;
4. validate the switched role, build the frozen opaque context, and run the callback;
5. reset local state, commit on success, otherwise rollback; discard temporary state and release in all cases.

The public root export changes from `TenantConnection` to an opaque `TenantDatabase` plus `TenantContext`. The database handle is backed by a private `WeakMap`, so it can only be passed to `withTenant`; raw `postgres` objects are not exposed from the package root. The context has a readonly role and closed repository/capability methods only. `account.readCurrent()` reads the account selected by the transaction context and accepts no account ID. `account.setIaEnabled(boolean)` is an API-role-only capability that updates only an active, non-deleted context account and throws when that predicate is not met. `unsafe`, a generic query function, SQL strings, dynamic identifiers, raw `postgres` objects, and an executor symbol are absent from the callback and package root exports.

`tenant-internal.ts` is an implementation-only module. It stores a backend executor and the canonical account ID in a `WeakMap<TenantContext, ActiveTenantExecutor>`, rejects expired contexts, and is reachable only by repository modules through relative source imports. `packages/db/package.json` exports only `.`; consumers cannot import the internal entrypoint through the package contract.

T017 will add `appendAuditEvent(context, input)` as a closed capability. It derives the account from the active context, locks that tenant's `account` row with `FOR UPDATE`, reads the account-local tail, and inserts the next event in the same transaction. The lock and executor both expire at callback completion. System audit handling is a separate T017 migration/design concern; it must not be smuggled through a tenant context.

## Invariants

- A callback cannot reach a newly granted table or function because its object has no generic execution method.
- A repository cannot select another tenant by accepting an arbitrary `accountId`; RLS and the context-derived account agree.
- A captured context and every repository capability fail after commit, rollback, or callback failure.
- Reporting remains read-only; API/worker capabilities remain explicitly enumerated.
- Existing connector/role ownership, `NOINHERIT`, `NOBYPASSRLS`, exact grants, rollback, and cleanup checks remain in force.
- Tests use a live post-preflight grant PoC; no test treats an extra firewall rule as a fix.

## Proof plan

1. Compile-time and runtime tests prove that `unsafe` and generic query fields are absent from `TenantContext`, and that the public `@touchmyapi/db` root exposes no raw connection factory or internal subpath.
2. The live-grant regression grants an otherwise privileged function/table to `api_rls` after role validation, then proves the only exposed `account.readCurrent()` capability neither reaches it nor exposes an invocation path.
3. Context expiry, callback rollback, backend cleanup, invalid role/context, and existing RLS A/B tests remain green.
4. T017 tests will prove same-account append serialization, cross-account independence, rollback atomicity, recursive redaction, and inability to forge/retain its transaction-bound audit capability.
