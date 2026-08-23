# T017 audit chain design

**Status:** Approved for implementation after accepted T016  
**Scope:** Append-only, redacted audit records for a tenant account and the accountless system boundary. No target access, queue, billing, runner, AI, report, membership, or admin feature is added.

## Decision

`appendAuditEvent(context, input)` is a closed repository operation over the accepted `TenantContext`; it never accepts SQL, a raw connection, or an account ID. It recursively redacts sensitive key names and JWT/PEM-like values before validation/persistence. It derives the account from the active context, locks `public.account` with `FOR UPDATE`, reads the account-local `audit_event` tail, and inserts the next event with `prev_event_id` inside the same transaction. The account-row lock serializes one tenant chain without advisory SQL.

Accountless system events use a separate opaque `SystemAuditDatabase` and `withSystemAudit` capability. A migration adds the singleton `audit_system_state(id='system')`; fixed system append code locks that row, reads only the `account_id IS NULL` tail, and inserts the next system event. A dedicated `audit_system` `NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` role and `audit_system_connector` login are limited by FORCE RLS to this singleton and accountless audit rows. Neither role has business-table privileges or a generic execution API.

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
