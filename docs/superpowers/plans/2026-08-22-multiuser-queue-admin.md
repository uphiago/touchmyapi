# Multi-user, PostgreSQL Queue and Admin Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account/workspace memberships and invitations, a fenced PostgreSQL queue with transactional outbox, and a separate MFA-protected admin control plane without weakening the foundation security model.

**Architecture:** Google identities remain global and immutable, while `account` is the tenant and `account_membership` is the only business authorization link. PostgreSQL remains queue source of truth: `SKIP LOCKED` claims, leases, fencing tokens, heartbeat, retry/backoff, reaper, fair scheduling, and outbox transactions provide recovery without Redis or Kafka. Admin uses a separate origin, staff identity, cookie, MFA, and short-lived policy-aware capability grants.

**Tech Stack:** Bun 1.4.0, TypeScript strict, Hono, PostgreSQL 16, Drizzle, `node-postgres`, Zod, Vitest, Web Crypto, existing RLS runtime roles, Stripe webhook boundary.

---

## Execution gate and file map

Execute T071–T086 after T021 is green and before the existing T022 assessment-state test. Membership and identity work is the first gate because assessment routes must never be built on an implicit single-user authorization model. Execute T087–T094 only after queue/outbox tests and the existing billing dependencies are available. Do not change T010–T021 completion checkboxes while implementing this plan.

| Area | Files | Responsibility |
| --- | --- | --- |
| Identity/membership | `packages/db/schema/identity.ts`, `packages/db/schema/membership.ts`, `packages/db/src/membership.ts`, `apps/api/src/auth/*`, `apps/api/src/routes/memberships.ts` | Global Google identity, account membership, invitation hash lifecycle, active-account session rotation |
| Contracts | `packages/contracts/src/membership.ts`, `packages/contracts/src/queue.ts`, `packages/contracts/src/admin.ts`, `specs/001-touchmyapi-platform/contracts/{membership,queue,admin}.md` | Closed request/response/event vocabulary and stable errors |
| Queue/outbox | `packages/db/schema/queue.ts`, `packages/db/src/queue.ts`, `packages/db/src/outbox.ts`, `apps/worker-control/src/scheduler.ts` | Claim, fencing, lease, heartbeat, retry, reaper, fairness, limits, delivery |
| Admin | `packages/db/schema/admin.ts`, `packages/db/src/admin.ts`, `apps/admin`, `apps/api/src/routes/admin.ts` | Staff identity/MFA, JIT grants, dual break-glass, policy-aware queue operations |
| Migration/review | `packages/db/migrations/0002_multiuser_queue_admin.sql`, `tests/integration/multiuser-migration.test.ts`, `tests/isolation/multiuser-rls.test.ts`, `docs/reviews/2026-08-22-multiuser-queue-admin.md` | Additive backfill, cutover, isolation proof, final traceability |

## Phase 2A: identity and membership (must precede T022)

### Task T071: Define membership and invitation contracts

**Files:**
- Create: `packages/contracts/src/membership.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `specs/001-touchmyapi-platform/contracts/index.md`

- [ ] **Step 1: Write failing contract tests** in `packages/contracts/test/membership.test.ts` for roles `owner/admin/operator/viewer/billing`, statuses, invitation input, and generic invalid-token errors. Run `bun run test:contract -- membership`; expected: FAIL because the module is absent.
- [ ] **Step 2: Define strict schemas** with `Role`, `MembershipStatus`, `InvitationStatus`, `membershipSchema`, `invitationCreateSchema`, `invitationAcceptSchema`, `accountSwitchSchema`, and response schemas. The invitation request accepts `email`, `role`, and `expiresAt`; it never accepts `accountId` from an untrusted browser context.
- [ ] **Step 3: Add stable errors** `membership_required`, `membership_suspended`, `invalid_invitation`, `invitation_expired`, `invitation_used`, `active_account_required`, and `last_owner_protected`; parse unknown keys as errors.
- [ ] **Step 4: Run `bun run test:contract -- membership && bun run typecheck`; expected: PASS. Commit `contracts: add membership invitation vocabulary`.

### Task T072: Add membership and invitation tables

**Files:**
- Create: `packages/db/schema/membership.ts`
- Modify: `packages/db/schema/identity.ts`
- Modify: `packages/db/schema/index.ts`
- Create: `packages/db/test/membership-schema.integration.test.ts`

- [ ] **Step 1: Write schema assertions** for `account_membership` (`account_id`, `identity_id`, `role`, status, timestamps, audit actor) and `account_invitation` (`account_id`, `token_hash`, email, role, expiry, use metadata). Run `RUN_DB_TESTS=1 bun run test:integration -- membership-schema`; expected: FAIL.
- [ ] **Step 2: Add composite tenant keys** and unique `(account_id, identity_id)` plus a partial unique active owner index. Invitations have a unique hash, no raw token column, and a check that expiry is after creation.
- [ ] **Step 3: Add account-scoped foreign keys** to account and global identity, re-export the schema, and keep global identity separate from membership business rows.
- [ ] **Step 4: Run `DATABASE_URL=$TEST_DATABASE bun run db:migrate && RUN_DB_TESTS=1 DATABASE_URL=$TEST_DATABASE bun run test:integration -- membership-schema`; expected: PASS. Commit `db: add account membership and invitation schema`.

### Task T073: Implement membership authorization matrix

**Files:**
- Create: `packages/policy/src/membership.ts`
- Create: `packages/policy/test/membership.test.ts`
- Modify: `packages/policy/src/index.ts`

- [ ] **Step 1: Write table-driven tests** proving owner/admin can manage members, operator can create/cancel assessments but cannot manage members or billing, viewer is read-only, and billing can read billing state but cannot create jobs or change entitlement. Run `bun run test:unit -- membership`; expected: FAIL.
- [ ] **Step 2: Implement `membershipCapabilities(role)`** returning a frozen closed capability set. Unknown role/status, removed membership, and suspended membership return no capabilities.
- [ ] **Step 3: Add `authorizeMembershipAction(input)`** that requires the active account, membership status, and requested capability; return stable denial codes without considering URL IDs as authorization.
- [ ] **Step 4: Run unit tests and `bun run typecheck`; expected: PASS. Commit `policy: enforce membership capabilities`.

### Task T074: Implement invitation token hashing and explicit acceptance

**Files:**
- Create: `packages/db/src/invitations.ts`
- Create: `apps/api/src/routes/invitations.ts`
- Create: `packages/db/test/invitations.integration.test.ts`

- [ ] **Step 1: Write failing integration tests** for random token generation, hash-only persistence, expiry, single use, wrong account, wrong identity, duplicate acceptance, and equal-email-without-acceptance. Run `RUN_DB_TESTS=1 bun run test:integration -- invitations`; expected: FAIL.
- [ ] **Step 2: Implement `createInvitation`** using 32 random bytes, SHA-256 token hash, strict role validation, account membership authorization, and a returned raw token only once. Redact raw token from logs and audit payloads.
- [ ] **Step 3: Implement `acceptInvitation`** in one transaction: lock by hash, validate active session identity and expiry, insert membership, mark used, append audit event, and rotate the session to the account. Do not query or compare email to discover an identity.
- [ ] **Step 4: Map invalid/expired/used tokens to the generic `invalid_invitation` response and run tests/typecheck; expected: PASS. Commit `feat: add explicit membership invitations`.

### Task T075: Make active account session-bound and rotatable

**Files:**
- Modify: `packages/db/schema/identity.ts`
- Modify: `packages/db/src/session.ts`
- Modify: `apps/api/src/auth/google.ts`
- Create: `apps/api/test/account-session.test.ts`

- [ ] **Step 1: Write tests** for first-login owner membership, multiple memberships, account switch rotation, old token revocation, revoked membership rejection, and absence of browser-only tenant selection. Run `bun run test:unit -- account-session`; expected: FAIL.
- [ ] **Step 2: Add `active_account_id` and `account_session_version`** to the server-side session record; resolve every request to exactly one active membership.
- [ ] **Step 3: Implement `switchAccount`** with membership validation, atomic old-session revocation, new opaque cookie issuance, hash-only persistence, and an audit event. Preserve the old account session only if a separate fresh login is intentionally created.
- [ ] **Step 4: Run auth/session tests, `bun run test:contract`, and `bun run typecheck`; expected: PASS. Commit `auth: bind sessions to active account`.

### Task T076: Add membership API routes

**Files:**
- Create: `apps/api/src/routes/memberships.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/memberships-api.test.ts`

- [ ] **Step 1: Write route tests** for list members, invite, accept, change role, remove member, list accounts, and switch account. Assert every mutation checks schema, active membership, state, policy, and audit sink.
- [ ] **Step 2: Implement routes** under `/api/v1/accounts/:accountId/memberships`, `/api/v1/invitations/:token/accept`, `/api/v1/accounts`, and `/api/v1/account/switch`. Derive account from session/membership and reject a mismatched path account with `403`.
- [ ] **Step 3: Enforce last-owner protection** and prohibit a member from removing their last owner membership without an approved transfer transaction.
- [ ] **Step 4: Run `bun run test:unit -- memberships-api && bun run typecheck`; expected: PASS. Commit `api: expose account membership lifecycle`.

### Task T077: Extend RLS and bootstrap isolation tests

**Files:**
- Create: `packages/db/migrations/0002_multiuser_queue_admin.sql`
- Modify: `tests/isolation/rls.test.ts`
- Create: `tests/isolation/multiuser-rls.test.ts`

- [ ] **Step 1: Write two-account tests** proving membership, invitation, session active-account, and audit rows cannot be selected, inserted, updated, deleted, or referenced across accounts with missing/invalid `app.tenant`.
- [ ] **Step 2: Add explicit policies** for new tables under `api_rls`, `worker_rls`, and `reporting_rls`; global identity bootstrap functions remain fixed-purpose and cannot perform arbitrary account lookup.
- [ ] **Step 3: Test owner/admin/operator/viewer/billing at the API boundary plus direct SQL under each runtime role. Run `RUN_DB_TESTS=1 bun run test:isolation`; expected: PASS.
- [ ] **Step 4: Commit `security: enforce membership rls isolation`.

### Task T078: Add account-scoped audit events and migration backfill

**Files:**
- Modify: `packages/db/src/audit.ts`
- Create: `packages/db/src/membership-audit.ts`
- Modify: `packages/db/migrations/0002_multiuser_queue_admin.sql`
- Create: `packages/db/test/membership-audit.integration.test.ts`

- [ ] **Step 1: Write tests** for invite create/accept, role change, removal, account switch, session rotation, and failed authorization; assert redaction and per-account chain order.
- [ ] **Step 2: Add additive backfill** that creates one owner membership for each legacy account/user with a valid immutable provider subject. Quarantine missing identities for explicit resolution and never match by email.
- [ ] **Step 3: Verify migration rerun and audit-chain integrity; run `DATABASE_URL=$TEST_DATABASE bun run db:migrate` twice and `RUN_DB_TESTS=1 bun run test:integration -- membership-audit`; expected: PASS.
- [ ] **Step 4: Commit `db: backfill legacy accounts into memberships`.

### Task T079: Add membership integration and quickstart proof

**Files:**
- Modify: `specs/001-touchmyapi-platform/quickstart.md`
- Create: `tests/integration/membership-flow.test.ts`

- [ ] **Step 1: Write an end-to-end fixture** with two Google identities, one shared account, one private account, invite acceptance, role restrictions, account switch, and session revocation.
- [ ] **Step 2: Run `RUN_DB_TESTS=1 bun run test:integration -- membership-flow`; expected: FAIL before fixture wiring.
- [ ] **Step 3: Document the exact commands and expected `owner/admin/operator/viewer/billing` outcomes in quickstart; no SSO or SCIM steps.
- [ ] **Step 4: Run `bun run test:integration -- membership-flow && git diff --check`; expected: PASS. Commit `docs: validate multiuser membership flow`.

### Task T080: Review identity and membership gate

**Files:**
- Create: `docs/reviews/2026-08-22-multiuser-membership.md`

- [ ] **Step 1: Record traceability** from FR-022–FR-027, Constitution III, and the membership contract to T071–T079.
- [ ] **Step 2: Run `bun run test:contract && bun run test:unit && bun run test:integration && bun run test:isolation && bun run typecheck && git diff --check`; expected: all applicable suites pass.
- [ ] **Step 3: Confirm no assessment route was implemented before this gate and leave T022 unchecked for the next phase.
- [ ] **Step 4: Commit `docs: review multiuser identity gate`.

### Task T081: Add active-account request context

**Files:**
- Create: `apps/api/src/account-context.ts`
- Modify: `apps/api/src/request-id.ts`
- Create: `apps/api/test/account-context.test.ts`

- [ ] **Step 1: Write tests** for missing session, suspended membership, stale membership version, and valid account context.
- [ ] **Step 2: Implement middleware** that resolves the session's active account and membership before account-scoped routes, then passes a typed context to RLS transaction wrappers.
- [ ] **Step 3: Assert path/body account IDs cannot override context; run `bun run test:unit -- account-context`; expected: PASS.
- [ ] **Step 4: Commit `api: require active account context`.

### Task T082: Add account deletion and membership lifecycle guards

**Files:**
- Modify: `apps/api/src/routes/account.ts`
- Create: `packages/policy/test/membership-lifecycle.test.ts`
- Modify: `specs/001-touchmyapi-platform/contracts/membership.md`

- [ ] **Step 1: Write tests** for owner transfer, last-owner deletion refusal, suspended-member access, account deletion revoking all memberships/sessions/invitations, and audit retention.
- [ ] **Step 2: Implement lifecycle guards** so deletion cancels schedules/jobs, revokes agents/tokens/sessions, and starts retention-aware elimination; never delete audit history early.
- [ ] **Step 3: Run `bun run test:unit -- membership-lifecycle && bun run typecheck`; expected: PASS. Commit `policy: guard membership and account lifecycle`.

### Task T083: Add membership metrics and security alerts

**Files:**
- Modify: `apps/worker-control/src/metrics.ts`
- Create: `apps/api/src/security-events.ts`
- Create: `apps/api/test/security-events.test.ts`

- [ ] **Step 1: Write tests** for invitation abuse, repeated invalid tokens, cross-account attempts, role changes, and session-switch failures.
- [ ] **Step 2: Record redacted counters** with account and actor identifiers hashed or scoped, never raw tokens/emails beyond the business row.
- [ ] **Step 3: Run `bun run test:unit -- security-events`; expected: PASS. Commit `ops: instrument membership security events`.

### Task T084: Add customer account UI contract

**Files:**
- Modify: `packages/ui/api-client.ts`
- Create: `apps/web/src/account-switcher.tsx`
- Create: `apps/web/src/memberships.tsx`
- Create: `apps/web/src/memberships.test.tsx`

- [ ] **Step 1: Write component tests** for account list, active account, role labels, invite form, explicit accept action, and no token/secret echo.
- [ ] **Step 2: Implement UI** using API-derived permissions; prices, entitlement, membership policy, and account IDs are not client authorities.
- [ ] **Step 3: Run `bun test apps/web/src/memberships.test.tsx && bun run --cwd apps/web build`; expected: PASS. Commit `web: add account membership controls`.

### Task T085: Update assessment authorization seams

**Files:**
- Modify: `packages/policy/src/engine.ts`
- Modify: `apps/api/src/routes/assessments.ts`
- Create: `tests/contract/assessment-membership-authorization.test.ts`

- [ ] **Step 1: Write tests** requiring operator/admin/owner for assessment creation/cancellation, viewer denial, billing denial, and account context from session.
- [ ] **Step 2: Thread membership capability into existing policy authorization** without changing the state machine or bypassing HTTP verification/attestation requirements.
- [ ] **Step 3: Run `bun run test:contract -- assessment-membership-authorization && bun run typecheck`; expected: PASS. Commit `policy: gate assessments by membership role`.

### Task T086: Membership phase acceptance checkpoint

**Files:**
- Modify: `docs/superpowers/specs/2026-08-22-multiuser-queue-admin-design.md`
- Create: `docs/reviews/2026-08-22-multiuser-membership-acceptance.md`

- [ ] **Step 1: Execute `bun run verify:workspace && bun run test:unit && bun run test:contract && bun run test:integration && bun run test:isolation && bun run typecheck && git diff --check`.
- [ ] **Step 2: Record evidence for identity separation, explicit invite acceptance, role matrix, active-account rotation, RLS, deletion, and assessment seam.
- [ ] **Step 3: Mark this gate accepted only when no unfinished artifact, auto-link, owner/BYPASSRLS, or unscoped account path remains; commit `docs: accept membership foundation`.

## Phase 2B: queue and transactional outbox

### Task T087: Define queue and outbox contracts

**Files:**
- Create: `packages/contracts/src/queue.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `specs/001-touchmyapi-platform/contracts/index.md`

- [ ] **Step 1: Write contract tests** for job status, `fencingToken`, lease timestamps, retry metadata, fair scheduling metadata, outbox event key, and policy-safe failure reasons. Run `bun run test:contract -- queue`; expected: FAIL.
- [ ] **Step 2: Define strict schemas** for `QueueJob`, `ClaimedJob`, `Heartbeat`, `Completion`, `RetrySchedule`, `OutboxEvent`, and `QueueAdminOperation`; require account ID and fencing token on every mutation.
- [ ] **Step 3: Run `bun run test:contract -- queue && bun run typecheck`; expected: PASS. Commit `contracts: add fenced queue vocabulary`.

### Task T088: Add queue and outbox schema/indexes

**Files:**
- Create: `packages/db/schema/queue.ts`
- Modify: `packages/db/schema/execution.ts`
- Modify: `packages/db/schema/index.ts`
- Modify: `packages/db/migrations/0002_multiuser_queue_admin.sql`
- Create: `packages/db/test/queue-schema.integration.test.ts`

- [ ] **Step 1: Write schema tests** for `available_at`, `priority`, `lease_owner`, `lease_expires_at`, `fencing_token`, attempts, terminal reason, stop signal, outbox uniqueness, and partial active-target uniqueness.
- [ ] **Step 2: Add indexes** for eligible jobs and fair account selection. The partial unique index covers non-terminal states and `(account_id, normalized_target_key)`; duplicate legacy rows are resolved before index creation.
- [ ] **Step 3: Add RLS policies** and tenant-composite foreign keys for queue/outbox rows; `LISTEN/NOTIFY` is not represented as a source-of-truth row.
- [ ] **Step 4: Run `DATABASE_URL=$TEST_DATABASE bun run db:migrate` twice and integration tests; expected: PASS. Commit `db: add fenced queue and outbox schema`.

### Task T089: Implement SKIP LOCKED claim and fencing

**Files:**
- Create: `packages/db/src/queue.ts`
- Create: `packages/db/test/queue-claim.integration.test.ts`

- [ ] **Step 1: Write concurrent tests** with two workers claiming the same eligible set; assert distinct rows, status transition, lease owner, and monotonic fencing token.
- [ ] **Step 2: Implement `claimNext`** in a transaction with `FOR UPDATE SKIP LOCKED`, account fairness score, tenant/global capacity, lease assignment, and fencing increment. Commit before dispatch.
- [ ] **Step 3: Implement `heartbeat`, `complete`, `fail`, and `requestCancel`** with `WHERE id/account_id/fencing_token/lease_owner` fencing predicates; stale writes return a no-op result.
- [ ] **Step 4: Run `RUN_DB_TESTS=1 bun run test:integration -- queue-claim`; expected: PASS. Commit `queue: claim jobs with postgres fencing`.

### Task T090: Implement retry/backoff, timeout, and reaper

**Files:**
- Modify: `packages/db/src/queue.ts`
- Create: `apps/worker-control/src/reaper.ts`
- Create: `packages/db/test/queue-recovery.integration.test.ts`

- [ ] **Step 1: Write tests** for half-lease heartbeat, expired lease recovery, bounded exponential backoff with jitter, exhausted attempts, timeout, cancellation, and preserved redacted reason.
- [ ] **Step 2: Implement reaper** with an atomic expired-lease update to `stale_recovered`, attempt increment, `available_at`, and terminal failure when `attempts >= max_attempts`.
- [ ] **Step 3: Ensure runner cleanup is required before terminal completion and that no retry widens policy limits or scope.
- [ ] **Step 4: Run `RUN_DB_TESTS=1 bun run test:integration -- queue-recovery`; expected: PASS. Commit `queue: recover leases with bounded retry`.

### Task T091: Implement fair scheduling and global limits

**Files:**
- Modify: `apps/worker-control/src/scheduler.ts`
- Create: `apps/worker-control/src/fair-scheduler.ts`
- Create: `apps/worker-control/test/fair-scheduler.test.ts`

- [ ] **Step 1: Write deterministic tests** with one noisy account and three quiet accounts; assert no account consumes all slots and tenant/global concurrency caps hold.
- [ ] **Step 2: Implement deficit/rotating account selection** from PostgreSQL metadata, then apply policy-reduced limits and per-target active uniqueness.
- [ ] **Step 3: Run `bun run test:unit -- fair-scheduler && bun run typecheck`; expected: PASS. Commit `worker: enforce fair queue scheduling`.

### Task T092: Implement transactional outbox and polling hint

**Files:**
- Create: `packages/db/src/outbox.ts`
- Create: `apps/worker-control/src/outbox-dispatcher.ts`
- Create: `packages/db/test/outbox.integration.test.ts`

- [ ] **Step 1: Write tests** proving state change plus outbox insert commit atomically, rollback removes both, duplicate delivery is idempotent, and missed `NOTIFY` is recovered by polling.
- [ ] **Step 2: Implement `appendOutboxEvent`** in the same transaction as assessment/job state changes, with unique event key and payload redaction.
- [ ] **Step 3: Implement at-least-once polling delivery** with optional `pg_notify` wake-up only; mark processed only after idempotent consumer acknowledgement.
- [ ] **Step 4: Run `RUN_DB_TESTS=1 bun run test:integration -- outbox`; expected: PASS. Commit `queue: add transactional outbox delivery`.

## Phase 2C: admin control plane

### Task T093: Define admin contracts and staff/MFA schema

**Files:**
- Create: `packages/contracts/src/admin.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/db/schema/admin.ts`
- Modify: `packages/db/schema/index.ts`
- Create: `packages/db/test/admin-schema.integration.test.ts`

- [ ] **Step 1: Write tests** for separate staff identity, MFA factor/challenge, capability enum, reason, ticket, TTL, approver, dual break-glass, and read-only billing operation.
- [ ] **Step 2: Implement strict schemas/tables** for `staff_identity`, `staff_session`, `mfa_factor`, `capability_grant`, and `admin_audit_event`. No table grants owner or bypass privileges.
- [ ] **Step 3: Add separate origin/cookie names and RLS/service boundaries; customer identity cannot satisfy staff authentication.
- [ ] **Step 4: Run schema contract/integration tests and `bun run typecheck`; expected: PASS. Commit `admin: add staff and capability contracts`.

### Task T094: Implement admin API, JIT grants, and final review

**Files:**
- Create: `apps/admin/src/app.ts`
- Create: `apps/admin/src/auth/mfa.ts`
- Create: `apps/api/src/routes/admin.ts`
- Create: `packages/db/src/admin.ts`
- Create: `tests/integration/admin-control-plane.test.ts`
- Create: `tests/isolation/admin-rls.test.ts`
- Create: `docs/reviews/2026-08-22-multiuser-queue-admin.md`

- [ ] **Step 1: Write failing tests** for separate origin/cookie, MFA-required session, JIT reason/ticket/TTL/approval, dual break-glass, no impersonation, no owner/BYPASSRLS, no arbitrary SQL, no secrets/raw evidence, read-only billing, policy-aware queue cancel/requeue/reap, and expired grant denial.
- [ ] **Step 2: Implement staff auth and MFA** with dedicated cookies/session rows and recent-MFA checks for sensitive actions. Do not reuse customer OAuth sessions.
- [ ] **Step 3: Implement capability grant lifecycle** requiring an account, closed capability, reason, ticket, TTL, one approver for normal grants, and two distinct approvers for break-glass. Store all decisions in append-only admin audit.
- [ ] **Step 4: Implement queue operations** as metadata/status actions through the existing policy engine; reject scope changes, arbitrary dispatch, billing writes, raw artifact retrieval, secret access, and impersonation.
- [ ] **Step 5: Run the full verification sequence:** `bun run verify:workspace && bun run test:unit && bun run test:contract && bun run test:integration && bun run test:isolation && bun run typecheck && bun run lint && bun run format && bun run --cwd apps/web build && docker compose -f infra/docker/compose.yml config && git diff --check`; expected: all exit 0.
- [ ] **Step 6: Complete review** against Constitution I–VI, FR-001–FR-027, SC-001–SC-016, contracts, migration/cutover, unfinished-artifact scans, and exact T071–T094 traceability. Commit `docs: review multiuser queue admin control plane`.

## Implementation handoff

This plan is documentation only. The implementer must use TDD, keep all T071–T094 checkboxes unchecked until evidence is green, execute membership before T022, preserve the Foundation Phase 2 historical non-goal, and never add Redis/Kafka, SSO, SCIM, impersonation, arbitrary SQL, owner/BYPASSRLS access, secret/raw-evidence admin paths, or billing writes.
