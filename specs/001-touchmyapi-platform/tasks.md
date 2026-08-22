# Tasks: TouchMyAPI Platform

**Input**: Design documents from `/specs/001-touchmyapi-platform/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Included. The product spec's acceptance criteria (SC-001..SC-010) are provable outcomes; constitution mandates RLS isolation, policy, and webhook tests. Written first, expected to fail before implementation.

**Organization**: Tasks grouped by user story (US1-US4) so each story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

Story labels: US1 = Authenticated Assessment Pipeline, US2 = Plans/Billing/Entitlement, US3 = Reports & Evidence, US4 = Private Agent.

## Path Conventions

- Bun monorepo (`apps/web`, `apps/api`, `apps/worker-control`, `apps/agent`, `packages/*`, `tests/*`), absolute paths per [plan.md](./plan.md).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo initialization, base tooling, CI baseline.

- [x] T001 Bootstrap Bun workspace monorepo (`bun init` + root `package.json` workspaces: `apps/*`, `packages/*`, `tests/*`)
- [x] T002 [P] Configure TypeScript strict shared config in `packages/tsconfig/base.json` (moduleResolution bundler, noUncheckedIndexedAccess)
- [ ] T003 [P] Configure Vitest at repo root (`vitest.config.ts`) with workspaces for unit/contract/integration/isolation/e2e
- [ ] T004 [P] Configure drizzle-kit + Drizzle ORM in `packages/db` (`drizzle.config.ts`, schema dir)
- [ ] T005 [P] Configure ESLint + Prettier at repo root (`.eslintrc`, `.prettierrc`); commit hooks via `husky`
- [ ] T006 [P] Create `.env.example` with documented vars (DATABASE_URL, GOOGLE_CLIENT_ID/SECRET, STRIPE_*, SANDBOX_IMPL, OBJECT_STORAGE_*); `.env` stays gitignored
- [ ] T007 [P] Add `infra/docker/compose.yml` for local PostgreSQL 16 + MinIO; seed scripts under `packages/db/scripts`
- [ ] T008 Verify `bun install`, `bun run test`, and `bun run db:migrate` are no-ops that run clean

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contracts, policy engine, RLS schema, session/auth primitives. MUST be complete before any user story.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [ ] T009 [P] Implement zod contract schemas in `packages/contracts/types.ts` for: assessment state machine, target categories, playbook contract, job spec, artifact manifest, export JSON, billing event, audit event (mirror `specs/001-.../contracts/`)
- [ ] T010 [P] Implement `packages/policy/scope.ts`: target normalization (external URL/domain/API spec → normalized descriptor), inclusion/exclusion matching, private/local/metadata-IP blocklist rules (per research R8)
- [ ] T011 [P] Implement `packages/policy/entitlement.ts`: plan rights matrix (free_unverified/free_verified/pro/lifetime) → allowed result visibility, playbook slice, credit caps (spec FR-005)
- [ ] T012 [P] Implement `packages/policy/limits.ts`: rate/duration/concurrency/credit cap reducer; browser/model/runner inputs can only reduce, never increase playbook limits (spec FR-014)
- [ ] T013 [P] Implement `packages/policy/engine.ts`: `authorize(action, scope, entitlement, limits) -> { allowed, blocked[], reason }`; policy-block testable via `tests/isolation/policy.test.ts`
- [ ] T014 [P] Implement `packages/db/schema.ts`: all tables from `data-model.md` (account, user, session, assessment, authorization_attestation, verification, playbook, job, runner_execution, credential, finding, report, credit_entry, billing_event, entitlement, agent, audit_event, notification) with `account_id` + enum types
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
- [ ] T024 [P] [US1] Integration test: queue durability - kill worker mid-run, restart, job recovers `stale_recovered` and finishes (spec SC-004) in `tests/integration/queue-recovery.test.ts`
- [ ] T025 [P] [US1] Integration test: second concurrent run for same target/account rejected in `tests/integration/assessment-concurrency.test.ts`

### Implementation for User Story 1

- [ ] T026 [P] [US1] Implement assessment entity/service in `packages/db` query layers (`assessment.ts`, `attestation.ts`) + state transition guards in `packages/policy/state.ts`
- [ ] T027 [US1] Implement `packages/db/queue.ts`: durable Postgres queue with `FOR UPDATE SKIP LOCKED` lease, retry/backoff, dedupe, timeout, abandoned-job recovery (research R3)
- [ ] T028 [US1] Implement `apps/api/src/routes/assessments.ts`: POST/GET/list/detail/cancel with policy-gated field visibility, validation of schema/ownership/state/entitlement on every mutation (spec FR-008, FR-014)
- [ ] T029 [US1] Implement `apps/worker-control/src/scheduler.ts`: leases queued jobs, enforces one-run-per-target/account + global limits, dispatches jobs, handles cancel/stop signal
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

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)**: no dependencies
- **Foundational (P2)**: depends on Setup; **BLOCKS all user stories**
- **US1 (P3)**: depends on P2 only
- **US2 (P4)**: depends on P2 + US1 foundational surfaces (assessment creation hooks into entitlement)
- **US3 (P5)**: depends on US1 (completed assessments) + US2 (plan gating)
- **US4 (P6)**: depends on P2 (policy, contracts) + worker-control (dispatch)
- **Polish (PN)**: depends on all stories

### User Story Dependencies

- US1: after P2; independent
- US2: after P2; integrates with US1 mutation path but independently testable
- US3: after US1+US2; independently testable
- US4: after P2 + worker-control; independently testable

### Within Each User Story

- Tests written and confirmed FAIL before implementation
- models/contracts → services → routes → integration → UI
- Story complete (tests green) before next priority

### Parallel Opportunities

- All [P] tasks within any phase can run in parallel
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
- After P2: US1 (pipeline) + US4 (agent channel) can proceed in parallel
- After US1: US2 (billing) + US3 (reporting prep) in parallel
- Story integration verified at end of each checkpoint

---

## Notes

- [P] = parallelizable (different files, no dependencies)
- [Story] maps each task to spec user story for traceability
- Verify tests FAIL before implementing (red), then implement to green
- Constitution gates: policy engine authority (II), RLS default deny (III), runner least privilege (IV), AI non-executor (V), webhook-only entitlement (VI) are re-checked at each checkpoint
- Commit after each logical task group; stop at any checkpoint to validate independently
- Avoid: vague tasks, same-file conflicts, cross-story dependencies that break independence; every task has an exact file path
