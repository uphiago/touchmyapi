# Foundation Phase 2 Checkpoint

**Date:** 2026-08-22

**Branch:** `feat/foundation-phase2`

**Scope:** Policy, schema, RLS, and accepted tenant-capability boundary; no T017+ implementation.

## Outcome

The accepted checkpoint is T010–T016. T016 replaced its arbitrary tenant-SQL callback with an opaque public database handle and transaction-bound closed capabilities, then passed both specification and adversarial quality review. T017–T021 were not started. No assessment, target network access, billing mutation, runner, report generation, AI execution, membership API, queue, or admin runtime was added.

| Task range | Status | Evidence |
| --- | --- | --- |
| T010 | Accepted | Pure scope normalization/blocklists; parser and fail-closed hardening reviewed |
| T011–T012 | Accepted | Closed entitlement matrix and immutable minimum-only limit reduction reviewed |
| T013 | Accepted | Default-deny policy engine, complete authoritative facts, IPv6 and entitlement binding reviewed |
| T014 | Accepted | PostgreSQL 16 schema, migrations, composite tenant references, exact constraints/defaults |
| T015 | Accepted | Least-privilege roles, forced RLS, narrow auth bootstrap, A/B isolation |
| T016 | Accepted | Opaque handle, closed role-specific capabilities, live-grant and lifecycle proof; spec/quality Ready: Yes |
| T017–T021 | Pending | No implementation files were added |
| T071–T094 | Design only | Membership, fenced PostgreSQL queue/outbox, and admin control-plane docs/tasks approved; no runtime implementation |

## T016 resolved finding

`withTenant` reserves one backend, begins before validation, sets a local tenant/role, validates exact role/table/function capabilities, blocks transaction/session escapes, and cleans the connection. It also blocks Unicode aliases, temporary persistence, large-object functions, advisory locks, role/session changes, and multi-statements.

The prior issue was the exported `TenantConnection.unsafe(query: string)` surface. A migration administrator could grant a new table/function capability to the active runtime role after the wrapper's post-`SET ROLE` validation and before a callback query. A PostgreSQL `REPEATABLE READ` probe did not freeze privilege checks, so another pre-query catalog check would only move the race.

The accepted fix is documented in `docs/superpowers/specs/2026-08-22-tenant-capability-boundary-design.md`: `@touchmyapi/db` exposes an opaque `TenantDatabase`, while `withTenant` gives a frozen `TenantContext` with only fixed role-specific capabilities. Its private executor and account ID are `WeakMap`-backed and expire at callback completion. Tests cover post-preflight table and worker-UPDATE grants, rollback of a real mutation, active-account predicates, captured-context expiry, principal safety, and parallel tenant transactions. Both review gates returned `Ready: Yes`; the audit writer remains a separate T017 operation.

## Verification evidence

Using Bun 1.4.0 and PostgreSQL 16 on `127.0.0.1` `_test` databases:

- Unit project: 216/216 passed; contract project: 24/24 passed.
- Integration project: historical 29/29 passed; current T016 focused integration passed 25/25 on a freshly migrated isolated `_test` database.
- Isolation project: 20/20 passed when run sequentially.
- The project total is 289 passed with the one intentionally pending e2e test skipped.
- Typecheck, ESLint, Prettier, workspace verification, web build, Compose config, and `git diff --check` passed during the respective gates.
- T016 specification review: `Ready: Yes`; adversarial quality review: `Ready: Yes` after the API-role-only mutation and late-worker-grant regression.

DB suites must not run concurrently against the same database. A parallel run made one database-wide auth assertion observe another suite's fixtures. Use `--maxWorkers=1` and run commands sequentially, or allocate one migrated `_test` database per process.

Two old `tma_t016_*` roles and one large object were observed in a reused local test database after prior interrupted probes. The accepted suites did not increase those counts. They are local test-environment hygiene debt and were not deleted automatically because they predated the final run and ownership was not proven.

## Resume order

1. Implement T017 audit chains using a narrow transaction-owned lock capability, not arbitrary advisory-lock SQL.
3. Continue T018–T021 and run the Foundation Phase 2 final acceptance gate.
4. Execute T071–T080 membership, T081–T087 PostgreSQL queue/outbox, and T088–T094 admin work in the documented dependency order.

The authoritative product/security decisions remain the constitution, global spec/plan/research/data model/contracts, and task list. This checkpoint records implementation evidence only; it does not override them.
