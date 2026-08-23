# Foundation Phase 2 Checkpoint

**Date:** 2026-08-22

**Branch:** `feat/foundation-phase2`

**Scope:** Pause after policy, schema, RLS, and tenant-wrapper hardening; no T017+ implementation.

## Outcome

The accepted checkpoint is T010–T015. T016 has working code and green focused tests, but remains unchecked because its adversarial quality gate is not ready. T017–T021 were not started. No assessment, target network access, billing mutation, runner, report generation, AI execution, membership API, queue, or admin runtime was added.

| Task range | Status | Evidence |
| --- | --- | --- |
| T010 | Accepted | Pure scope normalization/blocklists; parser and fail-closed hardening reviewed |
| T011–T012 | Accepted | Closed entitlement matrix and immutable minimum-only limit reduction reviewed |
| T013 | Accepted | Default-deny policy engine, complete authoritative facts, IPv6 and entitlement binding reviewed |
| T014 | Accepted | PostgreSQL 16 schema, migrations, composite tenant references, exact constraints/defaults |
| T015 | Accepted | Least-privilege roles, forced RLS, narrow auth bootstrap, A/B isolation |
| T016 | Review-blocked | Implementation and focused tests green; one Important adversarial finding remains |
| T017–T021 | Pending | No implementation files were added |
| T071–T094 | Design only | Membership, fenced PostgreSQL queue/outbox, and admin control-plane docs/tasks approved; no runtime implementation |

## T016 open finding

`withTenant` reserves one backend, begins before validation, sets a local tenant/role, validates exact role/table/function capabilities, blocks transaction/session escapes, and cleans the connection. It also blocks Unicode aliases, temporary persistence, large-object functions, advisory locks, role/session changes, and multi-statements.

The remaining issue is the exported `TenantConnection.unsafe(query: string)` surface. A migration administrator can grant a new table/function capability to the active runtime role after the wrapper's post-`SET ROLE` validation and before a callback query. A PostgreSQL `REPEATABLE READ` probe did not freeze privilege checks, so another pre-query catalog check would only move the race.

T016 must not be accepted by adding another denylist entry. The next design/implementation pass must replace arbitrary tenant SQL with closed, typed repository/capability operations (including a narrow audit-lock operation for T017), or enforce an equivalently reviewable database capability boundary. The quality review must then rerun the live-grant PoC and return `Ready: Yes`.

## Verification evidence

Using Bun 1.4.0 and PostgreSQL 16 on `127.0.0.1` `_test` databases:

- Unit project: 216/216 passed; contract project: 24/24 passed.
- Integration project: 29/29 passed, including T016 focused integration at 20/20.
- Isolation project: 20/20 passed when run sequentially.
- The project total is 289 passed with the one intentionally pending e2e test skipped.
- Typecheck, ESLint, Prettier, workspace verification, web build, Compose config, and `git diff --check` passed during the respective gates.
- Spec review for T016: `Ready: Yes`; adversarial quality review: `Ready: No` due to the live privileged-grant race above.

DB suites must not run concurrently against the same database. A parallel run made one database-wide auth assertion observe another suite's fixtures. Use `--maxWorkers=1` and run commands sequentially, or allocate one migrated `_test` database per process.

Two old `tma_t016_*` roles and one large object were observed in a reused local test database after prior interrupted probes. The accepted suites did not increase those counts. They are local test-environment hygiene debt and were not deleted automatically because they predated the final run and ownership was not proven.

## Resume order

1. Redesign T016 around closed tenant repository/capability operations and close the adversarial live-grant test.
2. Implement T017 audit chains using a narrow transaction-owned lock capability, not arbitrary advisory-lock SQL.
3. Continue T018–T021 and run the Foundation Phase 2 final acceptance gate.
4. Execute T071–T080 membership, T081–T087 PostgreSQL queue/outbox, and T088–T094 admin work in the documented dependency order.

The authoritative product/security decisions remain the constitution, global spec/plan/research/data model/contracts, and task list. This checkpoint records implementation evidence only; it does not override them.
