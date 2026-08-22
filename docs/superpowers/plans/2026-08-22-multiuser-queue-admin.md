# Multi-user, PostgreSQL Queue and Admin Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit account membership, a fenced PostgreSQL queue/outbox, and an isolated staff admin plane while preserving the existing `user` identity authority and Constitution 1.1.0.

**Architecture:** The existing `user` table remains the single global Google identity authority. `account_membership(account_id,user_id)` is the tenant authorization boundary; `session.account_id` is the one active account and switches rotate the session. PostgreSQL is queue source of truth with exact tenant fairness, `SKIP LOCKED`, leases, monotonic fencing, reaper/backoff, and a transactional at-least-once outbox. Admin has separate staff identity/OIDC, WebAuthn MFA, cookies, JIT support grants, and dual approval.

**Tech Stack:** Bun 1.4.0, TypeScript strict, Hono, PostgreSQL 16, Drizzle, `postgres` (postgres.js), Zod, Vitest, Web Crypto, WebAuthn, existing RLS runtime roles, Stripe webhook boundary.

---

## Execution gate, conventions, and file map

T071–T080 are the membership gate and MUST run after T021 is green. T081–T086 are queue/outbox infrastructure and T087 is the US1 integration gate; together T071–T087 MUST complete before existing T022 proceeds. T088–T094 are the separate admin stream and run only after queue primitives and billing read surfaces (T045) are available. Do not change T010–T021 completion checkboxes. Do not add a migration number by guess: run Drizzle generation, inspect the current journal/highest migration after T021, and use the next generated path.

Every task is TDD: write a failing test, run the exact red command, implement the smallest change, run the exact green command, then commit only that task's paths. Database commands always use PostgreSQL 16, `RUN_DB_TESTS=1`, an explicit local test URL, and `--maxWorkers=1` when state/order assumptions exist:

```bash
RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- <pattern>
```

`LISTEN/NOTIFY` is only a wake-up hint. Never use Redis/Kafka, a second customer identity table, email auto-linking, URL bearer tokens, owner/BYPASSRLS runtime access, impersonation, arbitrary SQL, secret/raw-evidence admin access, or billing writes.

| Area | Files | Responsibility |
| --- | --- | --- |
| Membership | Existing `packages/db/schema/identity.ts` (`user` only) plus `packages/db/schema/membership.ts`, `packages/db/src/{membership,invitations}.ts`, `apps/api/src/{auth,account-context}.ts`, `apps/api/src/routes/memberships.ts` | Existing `user` global identity, membership/invitation, session account binding, narrow auth functions; no second identity table |
| Queue/outbox | `packages/db/schema/{queue,execution}.ts`, `packages/db/src/{queue,outbox}.ts`, `apps/worker-control/src/{scheduler,reaper,outbox-dispatcher}.ts` | Claim, lease, fencing, heartbeat, recovery, exact fairness, transactional outbox |
| Admin | `packages/db/schema/admin.ts`, `packages/db/src/admin.ts`, `apps/admin/src`, `apps/api/src/routes/admin.ts` | Staff bootstrap/OIDC/WebAuthn/recovery, grants/approvals, safe queue/billing read API |
| Contracts | `packages/contracts/src/{membership,queue,admin}.ts`, `specs/001-touchmyapi-platform/contracts/{membership,queue,admin}.md` | Closed schemas and stable errors |
| Verification | `tests/{contract,integration,isolation,e2e}`, `specs/001-touchmyapi-platform/quickstart.md`, `docs/reviews/2026-08-22-multiuser-queue-admin.md` | Acceptance, cutover, isolation, and runbook evidence |

## Phase 2A membership: T071–T080 (after T021, before T022)

### Task T071: Membership and invitation contract (parallel, US5)

**Files:**
- Create: `packages/contracts/src/membership.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `specs/001-touchmyapi-platform/contracts/membership.md`
- Test: `packages/contracts/test/membership.test.ts`

- [ ] **RED:** Test strict `Role` (`owner`, `admin`, `operator`, `viewer`, `billing`), membership statuses, invitation create/accept body, account switch, generic errors, and unknown-key rejection. Run `bun run test:contract -- membership`; expected `FAIL` because the schema module is absent.
- [ ] **GREEN:** Define strict Zod contracts with `userId`, `accountId`, `acceptedByUserId`, `token` accepted only in the accept body, and stable `invalid_invitation`, `membership_required`, `membership_suspended`, `active_account_required`, and `last_owner_protected` errors. Run `bun run test:contract -- membership && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add packages/contracts/src packages/contracts/test/membership.test.ts specs/001-touchmyapi-platform/contracts/membership.md && git commit -m "contracts: define user membership and invitation"`.

### Task T072: Additive membership schema and expand backfill (parallel, US5)

**Files:**
- Modify: `packages/db/schema/identity.ts` (keep existing `user` authoritative)
- Create: `packages/db/schema/membership.ts`
- Modify: `packages/db/schema/index.ts`
- Create: `packages/db/test/membership-schema.integration.test.ts`
- Create: next generated Drizzle migration after journal inspection

- [ ] **RED:** Assert `account_membership(account_id,user_id)`, `account_invitation`, composite foreign keys, unique `(account_id,user_id)`, multiple active owners, and no second identity table. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- membership-schema`; expected `FAIL` before schema/migration.
- [ ] **GREEN:** Generate the next migration with `DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bunx drizzle-kit generate --config=drizzle.config.ts --name multiuser_queue_admin`, inspect the journal for the actual path, add membership/invitation tables and expand columns without removing `user.account_id`, and backfill one `owner` membership per valid legacy `user.account_id`. Quarantine missing users; never match by email. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- membership-schema`; expected `PASS`.
- [ ] **Commit:** `git add packages/db/schema packages/db/migrations packages/db/test/membership-schema.integration.test.ts && git commit -m "db: add account membership expand migration"`.

### Task T073: Membership role policy (parallel, US5)

**Files:**
- Create: `packages/policy/src/membership.ts`
- Modify: `packages/policy/src/index.ts`
- Test: `packages/policy/test/membership.test.ts`

- [ ] **RED:** Table-test all five roles and active/suspended/removed states: owner/admin manage members; operator creates/cancels assessments; viewer reads; billing reads billing and may initiate purchase intent only. Run `bun run test:unit -- membership`; expected `FAIL`.
- [ ] **GREEN:** Implement frozen capability sets keyed by `account_id,user_id`; allow multiple owners and make last-active-owner removal/demotion a transactional guard, not an index. Run `bun run test:unit -- membership && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add packages/policy/src/membership.ts packages/policy/src/index.ts packages/policy/test/membership.test.ts && git commit -m "policy: enforce membership role capabilities"`.

### Task T074: Narrow auth account list/switch/session functions (US5)

**Files:**
- Modify: `packages/db/src/auth-bootstrap.ts`
- Modify: next generated auth migration after journal inspection
- Modify: `packages/db/src/session.ts`
- Create: `apps/api/test/account-session.test.ts`

- [ ] **RED:** Test `auth_list_accounts(session_hash)` returns only safe account/member fields, `auth_switch_account(current_hash,target_account_id,new_hash,expiry)` requires active membership and rotates, `session.account_id` is authoritative, and customer functions cannot enumerate arbitrary accounts. Run `bun run test:unit -- account-session`; expected `FAIL`.
- [ ] **GREEN:** Add fixed-search-path, `auth_bootstrap`-only functions for list/switch; update Google completion to create the first owner membership; use only `session.account_id` for the active account. Preserve `user.account_id` during expand and rotate/revoke the old opaque session atomically. Run `bun run test:unit -- account-session && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add packages/db/src/auth-bootstrap.ts packages/db/src/session.ts apps/api/test/account-session.test.ts packages/db/migrations && git commit -m "auth: add narrow account list and switch"`.

### Task T075: Bearer invitation creation and explicit body acceptance (US5)

**Files:**
- Create: `packages/db/src/invitations.ts`
- Create: `apps/api/src/routes/invitations.ts`
- Create: `packages/db/test/invitations.integration.test.ts`
- Modify: `specs/001-touchmyapi-platform/contracts/membership.md`

- [ ] **RED:** Test 32 random bytes, SHA-256-only persistence, no URL token, body redaction before access/app logs, expiry/revocation/replay, same-user idempotency, other-user generic invalid, and equal-email non-linking. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- invitations`; expected `FAIL`.
- [ ] **GREEN:** Implement `POST /invitations/accept` with `{token}` body redacted before all logs; lock invitation, validate authenticated `user_id`, expiry/status/hash, insert membership, set `accepted_by_user_id`, rotate `session.account_id`, and append audit atomically. Replay by the same accepted user returns prior result; a different user, invalid, expired, or revoked token returns generic `invalid_invitation`. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- invitations && bun run typecheck`; expected `PASS`.
- [ ] **Verify/commit:** Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- invitations && bun run typecheck`; expected `PASS`. Commit `git add packages/db/src/invitations.ts apps/api/src/routes/invitations.ts packages/db/test/invitations.integration.test.ts specs/001-touchmyapi-platform/contracts/membership.md && git commit -m "feat: accept hashed invitations explicitly"`.

### Task T076: Membership/lifecycle API (US5)

**Files:**
- Create: `apps/api/src/routes/memberships.ts`
- Modify: `apps/api/src/routes/account.ts`
- Modify: `packages/policy/src/engine.ts`
- Modify: existing T026 assessment service and existing T028 assessment routes
- Create: `apps/api/test/memberships-api.test.ts`

- [ ] **RED:** Test list/invite/accept/role/status/remove/switch, active membership + role capability through `packages/policy/src/engine.ts`, T026 assessment-service authorization, T028 assessment-route membership-required behavior (not generic ownership), path account mismatch, suspended membership, and last-owner transaction guard. Run `bun run test:unit -- memberships-api`; expected `FAIL`.
- [ ] **GREEN:** Implement routes with `session.account_id`, active membership capability, schema/policy/audit checks, and the T026/T028 integration; require membership rather than generic ownership for assessment access, support multiple owners, and use a locked active-owner count that rejects only last-owner removal/demotion. Account deletion cancels jobs/schedules, revokes agents/sessions, and preserves audit retention. Run `bun run test:unit -- memberships-api && bun run typecheck`; expected `PASS`.
- [ ] **Verify/commit:** Run `bun run test:unit -- memberships-api && bun run typecheck`; expected `PASS`. Commit `git add apps/api/src/routes/memberships.ts apps/api/src/routes/account.ts apps/api/test/memberships-api.test.ts && git commit -m "api: enforce membership lifecycle"`.

### Task T077: Membership RLS and composite references (US5)

**Files:**
- Modify: next generated migration after journal inspection
- Modify: `packages/db/schema/assessment.ts`
- Modify: `packages/db/schema/identity.ts`
- Create: `tests/isolation/multiuser-rls.test.ts`

- [ ] **RED:** With two accounts/users, prove membership, invitation, session, assessment, and attestation cannot cross-read/write/reference under missing or wrong tenant. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:isolation --maxWorkers=1 -- multiuser-rls`; expected `FAIL`.
- [ ] **GREEN:** Add RLS policies and composite `(account_id,user_id)` membership FKs; bind `session.account_id` and attestation actor to membership where applicable. Keep global `user` lookup only in fixed auth functions. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:isolation --maxWorkers=1 -- multiuser-rls`; expected `PASS`.
- [ ] **Commit:** `git add packages/db/schema packages/db/migrations tests/isolation/multiuser-rls.test.ts && git commit -m "security: enforce membership rls boundaries"`.

### Task T078: Customer account UI and API client (parallel, US5)

**Files:**
- Modify: `packages/ui/api-client.ts`
- Create: `apps/web/src/account-switcher.tsx`
- Create: `apps/web/src/memberships.tsx`
- Create: `apps/web/src/memberships.test.tsx`

- [ ] **RED:** Test account list/active account, role labels, invitation creation and explicit accept form, no token URL construction, no token echo, and no browser authorization decisions. Run `bun test apps/web/src/memberships.test.tsx`; expected `FAIL`.
- [ ] **GREEN:** Implement server-permission-driven views and `POST /invitations/accept` body; use API-derived `session.account_id` and rotate after switch. Run `bun test apps/web/src/memberships.test.tsx && bun run --cwd apps/web build`; expected `PASS`.
- [ ] **Commit:** `git add packages/ui/api-client.ts apps/web/src && git commit -m "web: add explicit account membership controls"`.

### Task T079: Expand-contract cutover and review (US5)

**Files:**
- Create: `tests/integration/multiuser-migration.test.ts`
- Create: `docs/reviews/2026-08-22-multiuser-membership.md`
- Modify: `specs/001-touchmyapi-platform/quickstart.md`

- [ ] **RED:** Test legacy `user.account_id` + unique remains during expand, owner backfill, session account backfill, dual-read authorization, and explicit quarantine of missing users. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- multiuser-migration`; expected `FAIL`.
- [ ] **GREEN:** Document generate/inspect-next-journal procedure, dual-read, cutover to membership/session account, first-request rotation, and later removal of `user.account_id`/unique only after enforcement. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run db:migrate && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- multiuser-migration`; expected `PASS`.
- [ ] **Commit:** `git add tests/integration/multiuser-migration.test.ts docs/reviews/2026-08-22-multiuser-membership.md specs/001-touchmyapi-platform/quickstart.md && git commit -m "docs: review membership expand contract"`.

### Task T080: Membership acceptance gate (US5)

**Files:**
- Create: `docs/reviews/2026-08-22-multiuser-membership-acceptance.md`

- [ ] **RED:** Run `bun run test:unit && bun run test:contract && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:isolation --maxWorkers=1`; expected failure until T071–T079 evidence is complete.
- [ ] **GREEN:** Record FR-022/FR-023/SC-011/SC-012/SC-013 evidence, active membership + role capability in `packages/policy/src/engine.ts` and T026/T028, exact user-only identity names, multiple owners/last-owner guard, body-token redaction, auth list/switch functions, and legacy expand-contract. Run `bun run test:unit && bun run test:contract && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:isolation --maxWorkers=1`; expected `PASS`.
- [ ] **Commit:** `git add docs/reviews/2026-08-22-multiuser-membership-acceptance.md && git commit -m "docs: accept multiuser membership gate"`.

## Phase 2B queue/outbox infrastructure: T081–T087 (before T022)

### Task T081: Queue/outbox contract and schema (parallel, INFRA)

**Files:**
- Create: `packages/contracts/src/queue.ts`
- Create: `packages/db/schema/queue.ts`
- Modify: `packages/db/schema/execution.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: next generated migration after journal inspection
- Test: `packages/contracts/test/queue.test.ts`, `packages/db/test/queue-schema.integration.test.ts`

- [ ] **RED:** Test closed queue/outbox schemas, `queue_tenant_state`, statuses, fencing, outbox lease/heartbeat, and partial active index statuses. Run `bun run test:contract -- queue && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-schema`; expected `FAIL`.
- [ ] **GREEN:** Define `queue_tenant_state(account_id,last_dispatched_at,running_count,concurrency_limit)`, job fields, outbox `lease_owner/lease_expires_at/fencing_token/heartbeat_at`, and partial unique `(account_id,normalized_target_key)` for `queued/stale_recovered/running`. Generate and inspect the next migration, backfill every active account, and transactionally upsert state during account creation. Run `bun run test:contract -- queue && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-schema && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add packages/contracts packages/db/schema packages/db/migrations packages/contracts/test/queue.test.ts packages/db/test/queue-schema.integration.test.ts && git commit -m "queue: define fenced postgres schema"`.

### Task T082: Enqueue and exact fair claim (INFRA)

**Files:**
- Create: `packages/db/src/queue.ts`
- Create: `packages/db/test/queue-claim.integration.test.ts`
- Modify: `apps/worker-control/src/scheduler.ts`

- [ ] **RED:** Concurrently enqueue/claim jobs and assert eligible statuses are `queued`/`stale_recovered`, tenant lock order is `last_dispatched_at NULLS FIRST, account_id`, job order is `priority DESC, available_at, created_at, id`, global/tenant capacity holds, and no duplicate claim occurs. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-claim`; expected `FAIL`.
- [ ] **GREEN:** Implement one transaction: lock eligible tenant with `FOR UPDATE SKIP LOCKED`; lock its job with `FOR UPDATE SKIP LOCKED`; check limits; increment `fencing_token`; set `running`, lease, owner, started time; increment counter/update timestamp; commit before dispatch. Use the current `postgres` (postgres.js) driver boundary. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-claim && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add packages/db/src/queue.ts packages/db/test/queue-claim.integration.test.ts apps/worker-control/src/scheduler.ts && git commit -m "queue: claim jobs with exact tenant fairness"`.

### Task T083: Heartbeat, acknowledge, failure, cancel (INFRA)

**Files:**
- Modify: `packages/db/src/queue.ts`
- Create: `packages/db/test/queue-fencing.integration.test.ts`

- [ ] **RED:** Test heartbeat before half lease, completion/failure/cancel with matching account/lease owner/fencing, stale no-op, terminal counter decrement, and monotonic token after admin-style lease clearing. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-fencing`; expected `FAIL`.
- [ ] **GREEN:** Implement `heartbeat`, `complete`, `fail`, and `requestCancel` with fencing predicates; never reset token. Clear lease fields only for explicit requeue while leaving token unchanged. Require runner cleanup before terminal result. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-fencing && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add packages/db/src/queue.ts packages/db/test/queue-fencing.integration.test.ts && git commit -m "queue: fence heartbeat and terminal writes"`.

### Task T084: Reaper and stale retry recovery (INFRA)

**Files:**
- Create: `apps/worker-control/src/reaper.ts`
- Modify: `packages/db/src/queue.ts`
- Create: `packages/db/test/queue-recovery.integration.test.ts`

- [ ] **RED:** Test expired `running`→`stale_recovered`, attempts increment, backoff/available_at, counter decrement, next claim stale→running with incremented fencing, exhausted attempts→failed, timeout/cancel cleanup, and preserved safe reason. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-recovery`; expected `FAIL`.
- [ ] **GREEN:** Implement atomic reaper and bounded retry/jitter; never widen scope/policy or reset fencing. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-recovery && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add apps/worker-control/src/reaper.ts packages/db/src/queue.ts packages/db/test/queue-recovery.integration.test.ts && git commit -m "queue: recover stale leases with backoff"`.

### Task T085: Reconciler and exact fairness proof (INFRA)

**Files:**
- Create: `apps/worker-control/src/fair-scheduler.ts`
- Create: `apps/worker-control/src/reconciler.ts`
- Create: `apps/worker-control/test/fair-scheduler.test.ts`
- Create: `packages/db/test/queue-reconcile.integration.test.ts`

- [ ] **RED:** Test one noisy and three quiet accounts, null timestamp ordering, running counter increments/decrements, drift repair, tenant/global cap, missing-state fail-closed behavior, active-account state backfill, and the absence of an alternate fairness-score/deficit algorithm. Run `bun run test:unit -- fair-scheduler` and `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-reconcile`; expected `FAIL`.
- [ ] **GREEN:** Implement only the `queue_tenant_state` lock/order algorithm and reconciler that derives `running_count` from running jobs, creates missing rows for active accounts, repairs drift, fails closed without discarding queued jobs, and verifies account-create upsert. Run `bun run test:unit -- fair-scheduler && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-reconcile && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add apps/worker-control/src packages/worker-control/test packages/db/test/queue-reconcile.integration.test.ts && git commit -m "queue: prove tenant fairness and reconcile counters"`.

### Task T086: Transactional outbox and notification hint (INFRA)

**Files:**
- Create: `packages/db/src/outbox.ts`
- Create: `apps/worker-control/src/outbox-dispatcher.ts`
- Create: `packages/db/test/outbox.integration.test.ts`

- [ ] **RED:** Test state+outbox atomic commit/rollback, outbox claim `SKIP LOCKED`, short lease/heartbeat/fencing, expired `processing`→`pending` recovery, at-least-once duplicate delivery, idempotent `event_key`, and missed `NOTIFY` polling. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- outbox`; expected `FAIL`.
- [ ] **GREEN:** Implement outbox claim/heartbeat/ack/reaper with lease owner/expiry/fencing; keep `pg_notify` optional and never authoritative. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- outbox && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add packages/db/src/outbox.ts apps/worker-control/src/outbox-dispatcher.ts packages/db/test/outbox.integration.test.ts && git commit -m "queue: add fenced transactional outbox"`.

### Task T087: US1 integration and queue gate (US1)

**Files:**
- Modify: `tests/integration/queue-recovery.test.ts`
- Modify: `tests/integration/assessment-concurrency.test.ts`
- Modify: `specs/001-touchmyapi-platform/tasks.md`
- Create: `docs/reviews/2026-08-22-queue-integration.md`

- [ ] **RED:** Extend T024 to consume T084 and select `stale_recovered` on recovery; extend T025 to consume the partial active index over `queued/stale_recovered/running`, with distinct accounts allowed. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-recovery && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- assessment-concurrency`; expected `FAIL` until integration is wired.
- [ ] **GREEN:** Wire existing T027/T029 to the queue module delivered T081–T086; do not duplicate queue semantics in T027/T029. Record FR-024/FR-025/SC-004/SC-014/SC-015 evidence and leave T022 unchecked until this gate. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-recovery && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- assessment-concurrency && bun run test:contract && git diff --check`; expected `PASS`.
- [ ] **Commit:** `git add tests/integration/queue-recovery.test.ts tests/integration/assessment-concurrency.test.ts specs/001-touchmyapi-platform/tasks.md docs/reviews/2026-08-22-queue-integration.md && git commit -m "docs: accept queue integration gate"`.

## Phase 2C admin control plane: T088–T094 (after queue and billing read dependencies)

### Task T088: Admin contracts/schema/bootstrap (parallel, US6)

**Files:**
- Create: `packages/contracts/src/admin.ts`
- Create: `packages/db/schema/admin.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/db/schema/index.ts`
- Create: `packages/db/test/admin-schema.integration.test.ts`

- [ ] **RED:** Test exact names `staff_identity`, `staff_mfa_factor`, `staff_session`, `staff_role_assignment`, `support_access_grant`, `support_access_approval`, `admin_audit_event`; separate origin/cookie, closed capabilities, reason/ticket/TTL, dual approval, and read-only billing. Run `bun run test:contract -- admin && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- admin-schema`; expected `FAIL`.
- [ ] **GREEN:** Add strict contracts/tables with no owner/BYPASSRLS/arbitrary SQL path. Staff bootstrap is out-of-band CLI/migration-owner provision by immutable Workspace subject; domain-only provisioning is denied. Run `bun run test:contract -- admin && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- admin-schema && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add packages/contracts/src/admin.ts packages/db/schema/admin.ts packages/contracts/src/index.ts packages/db/schema/index.ts packages/db/test/admin-schema.integration.test.ts && git commit -m "admin: define staff and support access schema"`.

### Task T089: Separate staff OIDC, WebAuthn, recovery (US6)

**Files:**
- Create: `apps/admin/src/auth/oidc.ts`
- Create: `apps/admin/src/auth/webauthn.ts`
- Create: `apps/admin/src/auth/recovery.ts`
- Create: `apps/admin/test/auth.test.ts`

- [ ] **RED:** Test admin login/callback, customer-cookie rejection, immutable Workspace subject lookup, WebAuthn registration/assertion, `POST /admin/auth/recovery/verify` one-time hashed recovery, and dual-approved MFA reset. Run `bun run test:unit -- admin-auth`; expected `FAIL`.
- [ ] **GREEN:** Implement separate Google OIDC adapter/config, staff cookies/sessions, local WebAuthn MFA, one-time recovery hashes, `POST /admin/auth/recovery/verify`, and reset request/approval requiring two distinct staff identities. Run `bun run test:unit -- admin-auth && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add apps/admin/src/auth apps/admin/test/auth.test.ts && git commit -m "admin: add separate oidc and webauthn mfa"`.

### Task T090: JIT grants, approvals, break-glass (US6)

**Files:**
- Create: `packages/db/src/admin.ts`
- Create: `apps/api/src/routes/admin-grants.ts`
- Create: `packages/db/test/admin-grants.integration.test.ts`

- [ ] **RED:** Test missing MFA/grant/reason/ticket/TTL, normal one-approval, distinct dual break-glass, expiry/revocation, and append-only audit. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- admin-grants`; expected `FAIL`.
- [ ] **GREEN:** Implement `support_access_grant` plus `support_access_approval`, short TTL, capability enum, distinct approvers, and no customer impersonation. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- admin-grants && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add packages/db/src/admin.ts apps/api/src/routes/admin-grants.ts packages/db/test/admin-grants.integration.test.ts && git commit -m "admin: enforce jit support approvals"`.

### Task T091: Safe support and read-only billing API (after T045, US6)

**Files:**
- Create: `apps/api/src/routes/admin-support.ts`
- Create: `apps/api/src/routes/admin-billing.ts`
- Create: `apps/admin/test/support-api.test.ts`

- [ ] **RED:** Test separate staff session/MFA/grant on queue metadata/status and billing reads; deny secrets, raw evidence, signed job payload, arbitrary SQL, impersonation, credit grant, entitlement write, scope change, and runner dispatch. Run `bun run test:unit -- support-api`; expected `FAIL`.
- [ ] **GREEN:** Implement safe support metadata endpoints and read-only billing endpoint after the Stripe entitlement read model exists at T045. Run `bun run test:unit -- support-api && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add apps/api/src/routes/admin-support.ts apps/api/src/routes/admin-billing.ts apps/admin/test/support-api.test.ts && git commit -m "admin: expose safe support and billing reads"`.

### Task T092: Policy-aware queue operations (US6)

**Files:**
- Create: `apps/api/src/routes/admin-queue.ts`
- Modify: `packages/policy/src/engine.ts`
- Create: `tests/contract/admin-queue-policy.test.ts`

- [ ] **RED:** Test only metadata/status inspect, cancel, requeue, and bounded reaper are allowed with a valid non-expired grant; requeue clears lease but never resets fencing; scope/action/target changes and arbitrary dispatch deny. Run `bun run test:contract -- admin-queue-policy`; expected `FAIL`.
- [ ] **GREEN:** Route every operation through policy and support grant checks; preserve queue module semantics and fencing. Run `bun run test:contract -- admin-queue-policy && bun run typecheck`; expected `PASS`.
- [ ] **Commit:** `git add apps/api/src/routes/admin-queue.ts packages/policy/src/engine.ts tests/contract/admin-queue-policy.test.ts && git commit -m "admin: gate queue operations by policy"`.

### Task T093: Separate admin UI (parallel, US6)

**Files:**
- Create: `apps/admin/src/app.tsx`
- Create: `apps/admin/src/routes/login.tsx`
- Create: `apps/admin/src/routes/grants.tsx`
- Create: `apps/admin/src/routes/queue.tsx`
- Create: `apps/admin/src/routes/billing.tsx`
- Create: `apps/admin/src/admin.test.tsx`

- [ ] **RED:** Test separate origin/cookie, MFA gate, grant reason/ticket/TTL/approval, dual break-glass, queue metadata actions, read-only billing, and hidden secret/raw-evidence/impersonation controls. Run `bun test apps/admin/src/admin.test.tsx`; expected `FAIL`.
- [ ] **GREEN:** Implement the staff UI against API permissions; the browser cannot grant capabilities, alter policy, access raw evidence/secrets, or mutate billing. Run `bun test apps/admin/src/admin.test.tsx && bun run --cwd apps/admin build`; expected `PASS`.
- [ ] **Commit:** `git add apps/admin/src && git commit -m "admin: add isolated support console"`.

### Task T094: Admin isolation, e2e, runbook, and final review (US6)

**Files:**
- Create: `tests/isolation/admin-rls.test.ts`
- Create: `tests/e2e/multiuser-admin.test.ts`
- Create: `docs/reviews/2026-08-22-multiuser-queue-admin.md`
- Modify: `specs/001-touchmyapi-platform/quickstart.md`

- [ ] **RED:** Test customer/admin cookie separation, staff RLS, no owner/BYPASSRLS, no arbitrary SQL, no impersonation, no secrets/raw evidence, no billing writes, MFA/reset dual approval, grant TTL, queue fencing/fairness/reaper, invite body redaction/idempotency, and cross-account isolation. Run `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:isolation --maxWorkers=1 -- admin-rls` and `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:e2e --maxWorkers=1 -- multiuser-admin`; expected `FAIL` before the full plane is wired.
- [ ] **GREEN:** Record FR-022–FR-027, SC-011–SC-016, Constitution III, migration/cutover, contracts, and exact T071–T094 traceability. Run `bun run verify:workspace && bun run test:unit && bun run test:contract && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:isolation --maxWorkers=1 && bun run typecheck && bun run lint && bun run format && bun run --cwd apps/web build && docker compose -f infra/docker/compose.yml config && git diff --check`; expected `PASS` with e2e explicitly reported as pending only where not yet implemented.
- [ ] **Commit:** `git add tests/isolation/admin-rls.test.ts tests/e2e/multiuser-admin.test.ts docs/reviews/2026-08-22-multiuser-queue-admin.md specs/001-touchmyapi-platform/quickstart.md && git commit -m "docs: review multiuser queue admin control plane"`.

## Handoff constraints

This plan is documentation only. Keep T071–T094 unchecked until evidence is green, execute membership after T021 and before T022, integrate T024/T025/T027/T029 with the queue primitives rather than duplicating semantics, preserve `user` as the only customer identity authority, keep expand-contract legacy columns until cutover, and never add SSO, SCIM, Redis, Kafka, impersonation, arbitrary SQL, owner/BYPASSRLS access, secret/raw-evidence admin paths, or billing writes.
