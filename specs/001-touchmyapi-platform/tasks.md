# Tasks: TouchMyAPI Platform

**Input**: Design documents from `/specs/001-touchmyapi-platform/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Included. The product spec's acceptance criteria (SC-001..SC-010) are provable outcomes; constitution mandates RLS isolation, policy, and webhook tests. Written first, expected to fail before implementation.

**Organization**: Tasks grouped by user story (US1-US4) so each story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

Story labels: US1 = Authenticated Assessment Pipeline, US2 = Plans/Billing/Entitlement, US3 = Reports & Evidence, US4 = Private Agent, US5 = Shared Accounts & Collaboration, US6 = Admin Control Plane, INFRA = Queue & Outbox.

## Path Conventions

- Bun monorepo (`apps/web`, `apps/api`, `apps/worker-control`, `apps/agent`, `packages/*`, `tests/*`), absolute paths per [plan.md](./plan.md).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo initialization, base tooling, CI baseline.

- [x] T001 Bootstrap Bun workspace monorepo (`bun init` + root `package.json` workspaces: `apps/*`, `packages/*`, `tests/*`)
- [x] T002 [P] Configure TypeScript strict shared config in `packages/tsconfig/base.json` (moduleResolution bundler, noUncheckedIndexedAccess)
- [x] T003 [P] Configure Vitest at repo root (`vitest.config.ts`) with workspaces for unit/contract/integration/isolation/e2e
- [x] T004 [P] Configure drizzle-kit + Drizzle ORM in `packages/db` (`drizzle.config.ts`, schema dir)
- [x] T005 [P] Configure ESLint + Prettier at repo root (`.eslintrc`, `.prettierrc`); commit hooks via `husky`
- [x] T006 [P] Create `.env.example` with documented vars (DATABASE_URL, GOOGLE_CLIENT_ID/SECRET, STRIPE_*, SANDBOX_IMPL, OBJECT_STORAGE_*); `.env` stays gitignored
- [x] T007 [P] Add `infra/docker/compose.yml` for local PostgreSQL 16 + MinIO; seed scripts under `packages/db/scripts`
- [x] T008 Verify `bun install`, `bun run test`, and `bun run db:migrate` are no-ops that run clean

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contracts, policy engine, RLS schema, session/auth primitives. MUST be complete before any user story.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [x] T009 [P] Implement zod contract schemas in `packages/contracts/types.ts` for: assessment state machine, target categories, playbook contract, job spec, artifact manifest, export JSON, billing event, audit event (mirror `specs/001-.../contracts/`)
- [ ] T010 [P] Implement `packages/policy/scope.ts`: target normalization (external URL/domain/API spec → normalized descriptor), inclusion/exclusion matching, private/local/metadata-IP blocklist rules (per research R8)
- [ ] T011 [P] Implement `packages/policy/entitlement.ts`: plan rights matrix (free_unverified/free_verified/pro/lifetime) → allowed result visibility, playbook slice, credit caps (spec FR-005)
- [ ] T012 [P] Implement `packages/policy/limits.ts`: rate/duration/concurrency/credit cap reducer; browser/model/runner inputs can only reduce, never increase playbook limits (spec FR-014)
- [ ] T013 [P] Implement `packages/policy/engine.ts`: `authorize(action, scope, entitlement, limits) -> { allowed, blocked[], reason }`; policy-block testable via `tests/isolation/policy.test.ts`
- [ ] T014 [P] Implement the Foundation Phase 2 tables from `data-model.md` (account, existing global user, session, assessment, authorization_attestation, verification, playbook, job, runner_execution, credential, finding, report, credit_entry, billing_event, entitlement, agent, audit_event, notification) with `account_id` + enum types; Phase 2A membership, queue/outbox, and admin tables are additive in T072, T081, and T088
- [ ] T015 [P] Implement RLS bootstrap in `packages/db/migrations/*.sql` using Drizzle `pgPolicy`/`pgRole`: runtime roles `api_rls`/`worker_rls`/`reporting_rls`, tenant from `current_setting('app.tenant')`, default deny (spec FR-003, data-model RLS)
- [ ] T016 [P] Implement `packages/db/session.ts`: transaction wrapper that sets `app.tenant` + `set local role` per query; expose typed query client per role
- [ ] T017 [P] Implement `packages/contracts/audit.ts`: chained append-only audit event writer hitting `audit_event` with redaction helper (spec FR-018)
- [ ] T018 [P] Implement `packages/secrets/aead.ts`: envelope AEAD encrypt/decrypt for external credentials at rest (key per `key_id`, rotation hooks) (spec FR-010)
- [ ] T019 [P] Implement `packages/playbooks/index.ts`: playbook schema validation + `surface-public-posture@1.0.0` passive contract (actions: dns.records, tls.cert, http.headers, robots.txt, sitemap.xml, endpoint.minimal), per playbook contract doc
- [ ] T020 Implement `apps/api/src/server.ts`: Hono app skeleton with cookie session middleware, zod validation, error envelope `{error:{code,message}}`, centralized audit logging
- [ ] T021 Implement `apps/api/src/auth/google.ts`: Google OAuth PKCE via `openid-client` (login/callback/logout), HttpOnly Secure SameSite session cookies, rotation + revocation (spec FR-001/FR-002); GitHub/X remain model-disabled
- **Checkpoint**: Foundation ready - `bun run test:isolation` has RLS isolation test green (spec SC-002). User stories can begin.

---

## Phase 3: User Story 1 - Authenticated Assessment Pipeline (P1) 🎯 MVP

**Goal**: Google login, guided assessment creation, state machine, durable queue, passive run, dashboard, in-product notification.

**Independent Test**: quickstart scenarios 1-3: login + create passive free assessment + watch queued→running→analyzing→completed + notification, no verification required for passive slice.

### Tests (write FIRST, expect FAIL)

- [ ] T022 [P] [US1] Contract test: state-machine transition validity (all 8 states, idempotency, awaiting_verification bypass only for passive free) in `tests/contract/assessment-states.test.ts`
- [ ] T023 [P] [US1] Integration test: create assessment modal payload → row created as `draft` in `tests/integration/assessment-create.test.ts`
- [ ] T024 [P] [US1] Integration acceptance test consuming Phase 2B queue primitives: two workers claim `queued`/`stale_recovered` with `FOR UPDATE SKIP LOCKED`, `running` lease reaps to `stale_recovered` with backoff, and a restarted worker finishes under the current fencing token in `tests/integration/queue-recovery.test.ts`
- [ ] T025 [P] [US1] Integration acceptance test consuming Phase 2B queue primitives: second concurrent run for the same `account_id` + normalized target is rejected by the partial active index covering `queued`/`stale_recovered`/`running`; a different account may queue independently in `tests/integration/assessment-concurrency.test.ts`

### Implementation for User Story 1

- [ ] T026 [P] [US1] Implement assessment entity/service in `packages/db` query layers (`assessment.ts`, `attestation.ts`) + state transition guards in `packages/policy/state.ts`; every account-scoped service call must resolve an active `account_membership(account_id,user_id)` and role capability before mutation (FR-022/023, SC-011)
- [ ] T027 [US1] Integrate the queue module delivered by INFRA T081–T086 into assessment enqueue/state transitions and outbox writes; do not duplicate claim, fencing, reaper, fairness, or outbox semantics in this task (research R3; contracts/queue.md)
- [ ] T028 [US1] Implement `apps/api/src/routes/assessments.ts`: POST/GET/list/detail/cancel with policy-gated field visibility and validation of schema, required active membership and role capability, state, and entitlement on every mutation; membership is required, not generic ownership (spec FR-008, FR-014, FR-022/023, SC-011)
- [ ] T029 [US1] Integrate `apps/worker-control/src/scheduler.ts` with INFRA T082–T086: call exact `queue_tenant_state` fairness claim, dispatch only current fencing token, heartbeat before half-lease, handle cancel/cleanup, and poll outbox; do not reimplement queue primitives here
- [ ] T030 [US1] Implement `packages/runner/sandbox-provider.ts` interface + `packages/runner/podman-runsc.ts` impl (rootless Podman + gVisor runsc, digest-pinned image, non-root, read-only rootfs, tmpfs, cap-drop, seccomp, watchdog cleanup) (research R6). `SANDBOX_IMPL=noop` for CI
- [ ] T031 [US1] Implement `apps/worker-control/src/dispatch.ts`: signed job spec (Ed25519), `packages/secrets` short-lived credential channel (tmpfs 0600 pull, deleted on exit) (job contract; spec FR-010)
- [ ] T032 [US1] Implement passive playbook executor in `packages/playbooks/surface-public-posture.ts`: HTTP probes restricted to scope target, evidence as files + artifact manifest with hashes (job contract)
- [ ] T033 [US1] Implement `analyzing` resolution: DeepSeek planner/triage consumer (`packages/ai/planner.ts`) sanitized, policy-reduced; **deterministic rule-based fallback** when AI disabled/unreachable so analyzing never hard-blocks (spec FR-015, quickstart last note)
- [ ] T034 [US1] Implement findings store + plan-gated visibility in `apps/api/src/routes/findings.ts` (free-verified: title/category/severity only)
- [ ] T035 [US1] Implement in-product notification on completion in `apps/api/src/routes/notifications.ts` (kind `assessment_completed`, read/unread)
- [ ] T036 [US1] Implement `apps/web/src/` client: Google login, create-assessment guided modal (category → target → scope → limits → playbook → attestation, credential save/replace/delete, never echo), assessment list/detail dashboard, notifications bell. Public keys only (`VITE_*`)
- [ ] T037 [US1] Wire web client to API via typed client in `packages/ui/api-client.ts` (no entitlement/price logic in browser)

**Checkpoint**: US1 fully functional and testable independently (quickstart scenarios 1-3 + 5 pass). MVP demo-able.

---

## Phase 4: User Story 2 - Plans, Billing & Entitlement (P1)

**Goal**: Plan gating end-to-end; free unverified passive only; free verified masked; paid unlocks via validated Stripe webhooks only.

**Independent Test**: quickstart scenarios 6-7: free-verified masking holds; Stripe test checkout flips plan exactly once via webhook (replay changes nothing).

### Tests (write FIRST, expect FAIL)

- [ ] T038 [P] [US2] Contract test: playbook plan-slicing (unverified→passive only, verified→introductory masked) in `tests/contract/plan-gating.test.ts`
- [ ] T039 [P] [US2] Integration test: Stripe webhook signature reject (bad sig → 400), duplicate event id no-ops in `tests/integration/stripe-webhook.test.ts` (spec SC-005)
- [ ] T040 [P] [US2] Integration test: free-verified blocked from evidence/repro/PDF endpoints in `tests/integration/free-plan-block.test.ts`

### Implementation for User Story 2

- [ ] T041 [P] [US2] Implement catalog config in `packages/policy/catalog.ts`: prices, quotas, credit matrix (server-side only; plan FR-020, spec 3.3)
- [ ] T042 [US2] Implement credit ledger in `packages/db/credits.ts` + `credit_entry` consumption per target type/size (spec FR-005; never by finding count)
- [ ] T043 [US2] Implement `apps/api/src/routes/billing.ts`: create server-side order + Stripe Checkout session (one-off Pix/card, Pro subscription) + customer portal (spec FR-006)
- [ ] T044 [US2] Implement `apps/api/src/routes/webhooks/stripe.ts`: raw-body `constructEvent`, signature verify, dedupe-insert on `stripe_event_id` BEFORE side effects, enqueue processing, store minimal payload + result (spec FR-006, research R4)
- [ ] T045 [US2] Implement entitlement derivation in `packages/db/entitlement.ts`: plan/status/expiry derived from billing events; `entitlement` rows source-linked to events (spec FR-006)
- [ ] T046 [US2] Wire assessment creation + findings + reports + queue dispatch to entitlement checks from `packages/policy/entitlement.ts` at every mutation (spec FR-014)

**Checkpoint**: US1 + US2 both functional. Monetized MVP complete.

---

## Phase 5: User Story 3 - Reports & Evidence (P2)

**Goal**: PDF technical/executive, JSON export, signed URLs, plan-gated visibility, declarative limitations.

**Independent Test**: quickstart scenario 7: paid account downloads PDFs + JSON with redacted evidence; free (verified) gets nothing blocked.

### Tests (write FIRST, expect FAIL)

- [ ] T047 [P] [US3] Contract test: PDF technical contains methodology/scope/limitations/redacted evidence/severity/impact/remediation/findings appendix in `tests/contract/report-content.test.ts`
- [ ] T048 [P] [US3] Integration test: JSON export match `report.json@1` schema, zero secrets, redacted evidence in `tests/integration/json-export.test.ts`
- [ ] T049 [P] [US3] Integration test: signed URL minted only for owner+plan; tampered/foreign report id denied in `tests/integration/signed-url.test.ts`

### Implementation for User Story 3

- [ ] T050 [P] [US3] Implement `packages/reporting/sanitize.ts`: redaction of evidence/credentials/details per entitlement before any composition (defense at the render boundary; spec FR-013)
- [ ] T051 [US3] Implement `packages/reporting/pdf-technical.ts` + `pdf-executive.ts` via `@react-pdf/renderer` composing sanitized data, declaring untested items + scope limits + inference-vs-fact (spec FR-013)
- [ ] T052 [US3] Implement JSON export writer in `packages/reporting/json-export.ts` against `report.json@1`
- [ ] T053 [US3] Implement object storage client in `packages/secrets/object-store.ts`: private bucket, presigned temporary URLs, no public access (spec FR-012)
- [ ] T054 [US3] Implement `apps/api/src/routes/reports.ts`: report list + single-use signed download URL with ownership + entitlement checks

**Checkpoint**: US1-US3 complete; reports deliver the paid value. Deliverable milestone for external testing.

---

## Phase 6: User Story 4 - Private Agent for Internal Targets (P2)

**Goal**: Client-installed agent, outbound authenticated control channel, signed expiring job specs, local isolated runner, onboarding identity management.

**Independent Test**: quickstart scenario 8: agent connects outbound, dispatch internal job, artifacts return, internal credentials never reach server, revocation blocks dispatch.

### Tests (write FIRST, expect FAIL)

- [ ] T055 [P] [US4] Contract test: agent job spec signature/expiry accepted by agent, stale spec refused in `tests/contract/agent-job.test.ts`
- [ ] T056 [P] [US4] Integration test: agent connects outbound, receives signed spec, returns artifact manifest, no internal credential in flight/at server in `tests/integration/agent-channel.test.ts`
- [ ] T057 [P] [US4] Integration test: revoked agent token refused on next dispatch in `tests/integration/agent-revoke.test.ts`

### Implementation for User Story 4

- [ ] T058 [P] [US4] Implement `apps/api/src/routes/agents.ts`: create (token+fingerprint shown once), list, revoke; identity stored as hash (data-model `agent`)
- [ ] T059 [US4] Implement `apps/worker-control/src/agent-gateway.ts`: WebSocket/HTTPS outbound channel for agent identity, signed expiring job spec issuance (spec §7, research R11)
- [ ] T060 [US4] Implement `apps/agent/src/client.ts`: Bun agent process - outbound connect, receive signed spec, verify signature/expiry/capabilities, execute via local `SandboxProvider` (Podman runsc on agent host), return permitted artifacts, never send secrets (spec FR-017)
- [ ] T061 [US4] Implement agent onboarding UI in `apps/web/src/`: unique token, fingerprint, status, last activity, revocation (spec §7)
- [ ] T062 [US4] Wire internal-target dispatch through `packages/policy/engine.ts` (internal category, same policy authority; internal credentials never touch API/server) (spec §7)

**Checkpoint**: All user stories independently functional.

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Retention, audit chaining verification, reconciliation, hardening, docs.

- [ ] T063 [P] Implement retention sweeper in `apps/worker-control/src/retention.ts`: raw evidence 30d post-completion (scheduled delete), execution logs 30d, audit 365d, external credentials cleanup/retention rules (spec §9, FR-019)
- [ ] T064 [P] Implement Stripe reconciliation sweep re-processing unprocessed billing events (spec §8, research R4), alert on failures
- [ ] T065 [P] Verify audit chain integrity: test that `audit_event` is append-only and chained (no gap, `prev_id` links) in `tests/isolation/audit-chain.test.ts`
- [ ] T066 [P] Account deletion flow: cancel schedules, revoke agents/tokens, request session revocation, start data elimination per retention (spec §9, SC-010) in `apps/api/src/routes/account.ts`
- [ ] T067 [P] Metrics: queue depth, job age, failure rate per playbook, duration, cancellations, credit usage, policy blocks, webhook failures, cross-account attempts (spec §10) in `apps/worker-control/src/metrics.ts`
- [ ] T068 [P] Per-account external-AI disable flag honored in analyzer path (spec FR-016) + test in `tests/integration/ai-disable.test.ts`
- [ ] T069 [P] Run `specs/001-touchmyapi-platform/quickstart.md` validation end-to-end; fix drift from contracts/data-model
- [ ] T070 [P] Documentation pass: README (setup, run, architecture summary), `.env.example` finalize, `docs/` for ops

---

## Phase 2A: Multi-user accounts, PostgreSQL queue, outbox, and admin control plane

**Purpose**: Extend the foundation after T021 with the existing `user` identity as the sole global authority, explicit account membership, a fenced PostgreSQL queue/outbox, and a separate MFA-protected admin plane. T071–T086 MUST execute after T021 and before existing T022. T087 is the US1 queue integration gate. T088–T094 are US6 admin tasks after queue primitives and billing read dependencies. All tasks remain unchecked until their tests and review evidence are green.

**Non-goals preserved**: Foundation Phase 2 remains historically limited to T010–T021; this phase does not add SSO, SCIM, Redis, Kafka, impersonation, arbitrary SQL, owner/BYPASSRLS runtime access, secrets/raw evidence to admin, or billing writes.

### Phase 2A membership (after T021, before T022)

- [ ] T071 [P] [US5] Define strict membership/invitation contracts and stable errors (`packages/contracts/src/membership.ts`, `contracts/membership.md`): existing `user`, roles, explicit body acceptance, hash-only bearer token, expiry, single use, same-user idempotent replay, no email auto-link.
- [ ] T072 [P] [US5] Add additive `account_membership(account_id,user_id)`/invitation schema and expand backfill (`packages/db/schema/membership.ts`, next generated migration): preserve `user.account_id` during expand, allow multiple owners, no one-owner index.
- [ ] T073 [P] [US5] Implement/test role capabilities (`packages/policy/src/membership.ts`): owner/admin manage membership, operator runs assessments, viewer reads, billing reads/initiates purchase intent; last active owner removal/demotion is a transactional guard.
- [ ] T074 [US5] Update narrow auth/session functions (`packages/db/src/auth-bootstrap.ts`, `packages/db/src/session.ts`): `auth_list_accounts(session_hash)`, `auth_switch_account(current_hash,target_account_id,new_hash,expiry)`, fixed search path, `auth_bootstrap` only, `session.account_id`, no email/arbitrary enumeration.
- [ ] T075 [US5] Implement invitation creation/`POST /invitations/accept` body (`packages/db/src/invitations.ts`, `apps/api/src/routes/invitations.ts`) with 256-bit bearer token, SHA-256 storage, body redaction before access/app logs, same-user idempotency, generic other-user/invalid/expired/revoked errors.
- [ ] T076 [US5] Add account/membership/lifecycle API (`apps/api/src/routes/memberships.ts`, `account.ts`) and integrate active membership + role capability into `packages/policy/engine.ts`, existing T026 assessment services, and existing T028 assessment routes; enforce schema, session account, role policy, multi-owner/last-owner transaction guard, deletion revocation, and audit (FR-022/023, SC-011).
- [ ] T077 [US5] Extend RLS/composite references (`tests/isolation/multiuser-rls.test.ts`, next migration) for membership, invitation, `session.account_id`, and attestation membership FKs; prove two-account denial.
- [ ] T078 [P] [US5] Add customer account switcher/membership UI (`apps/web/src/account-switcher.tsx`, `memberships.tsx`) using body acceptance and server permissions; no token URL/echo or browser authority.
- [ ] T079 [US5] Execute expand-contract cutover review (`tests/integration/multiuser-migration.test.ts`, `docs/reviews/2026-08-22-multiuser-membership.md`, `quickstart.md`): generate/inspect next journal, dual-read, cutover, session rotation, later removal of `user.account_id`/unique only after enforcement.
- [ ] T080 [US5] Run membership acceptance gate (`docs/reviews/2026-08-22-multiuser-membership-acceptance.md`) with TDD evidence for FR-022/023, SC-011/012/013, active membership + role capability in `packages/policy/engine.ts` and T026/T028, identity naming, auth list/switch, owner guard, body redaction, RLS, and migration; leave T022 unchecked.

### Phase 2B queue/outbox (T081–T087, before T022)

- [ ] T081 [P] [INFRA] Define queue/outbox contracts/schema (`packages/contracts/src/queue.ts`, `packages/db/schema/queue.ts`, next generated migration): `queue_tenant_state`, eligible statuses, partial active index over `queued/stale_recovered/running`, outbox lease/heartbeat/fencing, backfill one state row for every active account, transactional account-create upsert, and fail-closed behavior that leaves jobs queued when state is missing.
- [ ] T082 [INFRA] Implement enqueue/exact fair claim (`packages/db/src/queue.ts`, scheduler): tenant `FOR UPDATE SKIP LOCKED` order `last_dispatched_at NULLS FIRST,account_id`; job order `priority DESC,available_at,created_at,id`; atomic counters/timestamp; postgres.js driver.
- [ ] T083 [INFRA] Implement heartbeat/ack/fail/cancel (`packages/db/src/queue.ts`): account/lease-owner/fencing predicates, stale no-op, terminal counter decrement, never reset fencing, admin requeue clears lease only.
- [ ] T084 [INFRA] Implement reaper/retry (`apps/worker-control/src/reaper.ts`, queue tests): `running→stale_recovered` with available_at/backoff/counter decrement, next claim stale→running with token increment, exhausted→failed, cleanup.
- [ ] T085 [INFRA] Implement fairness reconciler (`apps/worker-control/src/{fair-scheduler,reconciler}.ts`): exact `queue_tenant_state`, global/tenant caps, noisy/quiet proof, create missing rows for active accounts, repair running-count drift, fail closed when tenant state is missing, and keep jobs queued rather than stranded; no deficit/fair score.
- [ ] T086 [INFRA] Implement transactional outbox (`packages/db/src/outbox.ts`, dispatcher): claim `SKIP LOCKED`, short lease/heartbeat/fencing, expired processing recovery, at-least-once idempotent event key, polling with `NOTIFY` hint.
- [ ] T087 [US1] Integrate queue primitives into T024/T025/T027/T029 and gate (`tests/integration/{queue-recovery,assessment-concurrency}.test.ts`, review): T024 selects `stale_recovered`, T025 consumes active index, T027/T029 integrate without duplicate semantics; FR-024/025 and SC-004/014/015 evidence.

### Phase 2C admin control plane (T088–T094, after queue and billing read dependencies)

- [ ] T088 [P] [US6] Define admin contracts/schema/bootstrap (`packages/contracts/src/admin.ts`, `packages/db/schema/admin.ts`): exact staff/support names, separate cookies/origin, out-of-band immutable Workspace subject bootstrap, no domain-only/no customer auth.
- [ ] T089 [US6] Implement staff OIDC/WebAuthn/recovery (`apps/admin/src/auth/*`): separate Google OIDC, local WebAuthn MFA, hashed one-time recovery, dual-approved MFA reset, dedicated staff session.
- [ ] T090 [US6] Implement JIT grants/approvals/break-glass (`packages/db/src/admin.ts`, grant routes): reason/ticket/TTL, normal approval, two distinct break-glass approvers, append-only audit.
- [ ] T091 [US6] Implement safe support and read-only billing API after T045 (`apps/api/src/routes/admin-{support,billing}.ts`): metadata/status only; deny secrets/raw evidence/signed jobs/arbitrary SQL/impersonation/credit or entitlement writes.
- [ ] T092 [US6] Implement policy-aware queue ops (`apps/api/src/routes/admin-queue.ts`, policy test): inspect/cancel/requeue/reaper only; requeue clears lease and never resets fencing; no scope/action/target changes or arbitrary dispatch.
- [ ] T093 [P] [US6] Implement separate admin UI (`apps/admin/src`): login/callback/WebAuthn/grants/queue/billing read-only; browser cannot grant capability, alter policy, access secrets/raw evidence, or mutate billing.
- [ ] T094 [US6] Run admin RLS/e2e/runbook/review (`tests/isolation/admin-rls.test.ts`, `tests/e2e/multiuser-admin.test.ts`, `docs/reviews/2026-08-22-multiuser-queue-admin.md`, `quickstart.md`) proving FR-022–027, SC-011–016, and all no-bypass constraints.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)**: no dependencies
- **Foundational (P2)**: depends on Setup; **BLOCKS all user stories**
- **Phase 2A membership (T071–T080)**: depends on T021; **BLOCKS T022 and all account-scoped assessment mutations**
- **Phase 2B queue/outbox (T081–T087)**: depends on T080; T087 integrates and enriches T024/T025/T027/T029; PostgreSQL remains source of truth
- **US1 queue gate (T087)**: must pass before T022; no duplicate queue semantics in existing T027/T029
- **Phase 2C admin (T088–T094)**: depends on queue/outbox T081–T087 and billing read model T045; separate staff/MFA origin; no billing writes
- **US1 (P3)**: depends on P2 + T080 membership gate + T087 queue gate
- **US2 (P4)**: depends on P2 + US1 foundational surfaces (assessment creation hooks into entitlement)
- **US3 (P5)**: depends on US1 (completed assessments) + US2 (plan gating)
- **US4 (P6)**: depends on P2 (policy, contracts) + worker-control (dispatch)
- **Polish (PN)**: depends on all stories

### User Story Dependencies

- US1: after P2 and T080/T087 gates; assessment state tests T022 follow T087
- US2: after P2; integrates with US1 mutation path but independently testable
- US3: after US1+US2; independently testable
- US4: after P2 + worker-control; independently testable

### Within Each User Story

- Tests written and confirmed FAIL before implementation
- models/contracts → services → routes → integration → UI
- Story complete (tests green) before next priority

### Parallel Opportunities

- All [P] tasks within any phase can run in parallel only when their file sets do not overlap
- Phase 2 foundational [P] tasks are the main concurrency win (contracts/policy/db/secrets/playbooks/auth)
- Different user stories can run in parallel after P2 (e.g. US4 agent channel while US3 reporting)

### Parallel Example: Phase 2 foundational

```bash
# Launch in parallel:
Task: "T009 contracts in packages/contracts/types.ts"
Task: "T010-T013 policy engine in packages/policy/"
Task: "T014-T016 RLS schema + runtime roles in packages/db/"
Task: "T018 secrets AEAD in packages/secrets/aead.ts"
Task: "T019 playbooks in packages/playbooks/index.ts"
Task: "T021 Google OAuth PKCE in apps/api/src/auth/google.ts"
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 Setup
2. Phase 2 Foundational (CRITICAL)
3. Phase 3 US1 (auth + assessment pipeline + passive run + dashboard + notification)
4. **STOP and VALIDATE**: quickstart scenarios 1, 2, 3, 5
5. Deploy/demo safe (passive-only, no payment surface live)

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 → MVP: auth, state machine, queue, passive assessment, dashboard, notification
3. US2 → monetized MVP: plan gating, Stripe webhook entitlement
4. US3 → deliverables: PDF/JSON reports, signed URLs
5. US4 → internal environments: private agent
6. Polish → retention, audit, reconciliation, deletion, metrics, AI-disable

### Parallel Team Strategy

- Team completes Setup + Foundational together
- After T021: membership tasks T071–T080 execute first; T022 is explicitly blocked until T087
- After T080: queue/outbox tasks T081–T086 execute; T087 integrates T024/T025/T027/T029 and gates T022
- After T087 and T045: admin tasks T088–T094 execute; US1/US4 proceed only where membership/policy seams are complete
- After US1: US2 (billing) + US3 (reporting prep) in parallel
- Story integration verified at end of each checkpoint

---

## Notes

- [P] = parallelizable (different files, no dependencies)
- `[US5]`, `[US6]`, and `[INFRA]` identify the Phase 2A traceability groups; all are unchecked until tests/review are green.
- [Story] maps each task to spec user story for traceability
- Verify tests FAIL before implementing (red), then implement to green
- Constitution gates: policy engine authority (II), RLS default deny (III), runner least privilege (IV), AI non-executor (V), webhook-only entitlement (VI) are re-checked at each checkpoint
- Phase 2A gates: existing `user` is the only customer identity authority; account membership is explicit and RLS-protected; queue claims are exact/fenced/recoverable; outbox is transactional and at-least-once; admin is separate OIDC/WebAuthn/MFA/JIT and has no impersonation, owner/BYPASSRLS, arbitrary SQL, secret/raw-evidence, or billing-write path.
- Commit after each logical task group; stop at any checkpoint to validate independently
- Avoid: vague tasks, same-file conflicts, cross-story dependencies that break independence; every task has an exact file path
