# T017 audit chain design

**Status:** Approved for implementation after accepted T016  
**Scope:** Append-only, redacted audit records for a tenant account and the accountless system boundary. No target access, queue, billing, runner, AI, report, membership, or admin feature is added.

## Decision

`appendAuditEvent(context, input)` is a closed repository operation over the accepted `TenantContext`; it never accepts SQL, a raw connection, or an account ID. It recursively redacts sensitive key names and JWT/PEM-like values before validation/persistence. It derives the account from the active context, locks `public.audit_account_state(account_id)` with `FOR UPDATE`, reads the account-local `audit_event` tail, and inserts the next event with `prev_event_id` inside the same transaction. The account-lock row serializes one tenant chain without advisory SQL.

`audit_account_state` is a dedicated one-row-per-account lock authority, seeded
for existing accounts and created atomically by the login/bootstrap account
creation path. API and worker receive only `SELECT` plus PostgreSQL's required
lock-only `UPDATE` ACL/RLS policy for their own immutable `account_id`; neither
role receives an account-table UPDATE grant or a mutable state field. This
keeps append support available to both runtime producers without making the
business account relation a worker lock primitive.

Each audit row receives a global monotonic `chain_seq` from the migration-owner-
owned `audit_event_chain_seq` sequence. Tenant and system tails order by this
sequence rather than transaction-start timestamps, so a transaction that began
before waiting on the account lock cannot move the chain backward. Runtime
roles receive only sequence `USAGE` for their fixed inserts; `SELECT` is
explicitly revoked so the sequence is not a raw ordering API. Runtime audit
inserts are column-granted for the fixed writer shape and cannot provide
`chain_seq` or `created_at`; the database assigns `chain_seq` by default.

The login/bootstrap SECURITY DEFINER path evaluates its FORCE-RLS bootstrap
policies as the migration owner, locks the account-state row before selecting
the tail, and writes a linked audit event. The bootstrap policies include only
`auth_bootstrap` and that exact migration owner; runtime and system roles are
excluded.

Accountless system events use a separate opaque `SystemAuditDatabase` and `withSystemAudit` capability. A migration adds the singleton `audit_system_state(id='system')`; fixed system append code locks that row, reads only the `account_id IS NULL` tail, and inserts the next system event. A dedicated `audit_system` `NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` role and `audit_system_connector` login are limited by FORCE RLS to this singleton and accountless audit rows. Neither role has business-table privileges or a generic execution API.

PostgreSQL requires a narrow `UPDATE` ACL and matching FORCE-RLS policy for a
`SELECT ... FOR UPDATE` row lock. The tenant/system lock roles therefore have
lock-only `UPDATE` privileges on `audit_account_state` and `audit_system_state`.
The state rows have no mutable payload (only a tenant key or the check-constrained
`id = 'system'`), and fixed writers never issue UPDATE. This is an intentional
lock-only exception to SELECT-only data access, retained to provide deterministic
concurrency without advisory locks or a definer function.

## Alternatives rejected

1. `pg_advisory_xact_lock`: a fixed use could serialize chains, but T016 deliberately removed any arbitrary advisory-lock surface and account/system rows provide auditable, inspectable serialization.
2. Lock the last event only: the empty-chain case has no row and concurrent first inserts race.
3. Allow `account_id = null` through a tenant context: this weakens tenant semantics and obscures system authority; system gets a dedicated role and singleton.

## Invariants and tests

- Runtime contexts can insert but cannot update/delete audit history; `account_id` is context derived.
- Same-account concurrent writers have a single ordered chain; different account and system chains do not share a lock.
- A mutation and its audit append roll back together on any failure.
- Captured tenant/system capabilities expire when their callback ends.
- Redaction handles nested object/array keys (`password`, `token`, `authorization`, `cookie`, `secret`, `privateKey`) and JWT/PEM values before an insert; errors contain no plaintext or key material.
- The system connector has no business table grants, no owner/BYPASSRLS path, and cannot append a tenant event.
