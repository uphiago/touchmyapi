# TouchMyAPI Passive Delivery V1 Implementation Plan

> Execute in order with red-green-refactor checkpoints. The binding design is `docs/superpowers/specs/2026-08-24-passive-delivery-v1-design.md`; the constitution remains authoritative.

**Goal:** Complete T106 as a durable, tenant-isolated customer delivery pipeline without allowing the browser, queue connector, AI, or control worker to become an execution authority.

**Architecture:** Keep PostgreSQL queue control and tenant delivery as separate least-privilege capabilities. Add a signed runner port and deterministic local fixture, fenced/idempotent result publication, policy-filtered API contracts, sanitized reports in private object storage, and honest readiness/deployment gates.

**Stack:** Bun 1.4, TypeScript, Hono, React/Vite, PostgreSQL 16/RLS, Vitest, Docker Compose, S3-compatible private storage, `@react-pdf/renderer`.

## Phase 1 — Contracts and durable publication

1. Add contract tests for finding summaries/details, notifications, report metadata/downloads, runner request/result, and assessment detail responses. Export strict Zod schemas with no credential/token fields.
2. Add migration tests first for deterministic finding/report keys and one completion notification per assessment. Generate an additive migration with unique constraints and the minimum worker/reporting grants.
3. Add database integration/isolation tests for worker job input and fenced publication: current fence succeeds, stale fence is a no-op, retry is idempotent, and a worker scoped to account A cannot observe or publish account B.
4. Implement closed `worker_rls` repositories. No raw SQL callback or arbitrary tenant identifier reaches application callers.
5. Provision `worker_connector` and `reporting_connector` with `NOINHERIT`, no direct grants, and only settable membership in their one runtime role. Extend connector contract tests and deploy configuration.

## Phase 2 — Deterministic execution and analysis

6. Add analyzer tests mapping bounded DNS/TLS/HTTP facts to stable `info`/`low` findings. Assert stable source keys, normalized text, output limits, redaction, and no interpretation of target content as commands.
7. Implement the analyzer as a pure package. It receives only parsed `job.artifacts@1` facts and returns validated findings plus declared limitations/untested actions.
8. Add signing/verification tests for Ed25519 specs: expiry, job/account binding, unknown actions/capabilities, altered payload, replay, and key rotation all fail closed.
9. Implement the runner client port and deterministic local fixture. The fixture must be development-only, clearly labeled, stable across runs, and contain no network calls.
10. Add a production runner adapter only behind an isolated-runner readiness probe. Do not mount the host container socket into application services. Record any host prerequisite as an explicit deployment task until the sandbox smoke proves it.

## Phase 3 — Worker service

11. Add worker-loop tests for idle polling, claim, state transitions, heartbeats, graceful shutdown, completion, retryable failure, permanent failure, stale fencing, cancellation and cleanup failure.
12. Implement `apps/worker-control` runtime/config/health/readiness. Use separate queue and worker database URLs, structured redacted logs, bounded concurrency and abortable polling.
13. Publish runner execution, findings, reports, notification and audit intent idempotently under the current fence, then call queue completion. Reflect failed/cancelled outcomes in the assessment without exposing raw runner output.
14. Extend local development to start worker-control and private MinIO, execute one fixture assessment end-to-end, and assert `draft → queued → running → analyzing → completed` plus notification and deliverables.

## Phase 4 — Customer delivery API and UI

15. Add route tests for assessment detail, findings, notification list/read, report list and download. Cover unauthenticated, inactive member, wrong tenant, wrong role, free plan, paid plan, tampered token, expired token and storage unavailable.
16. Implement Postgres stores and Hono routes. Resolve plan on the server, use `rightsForPlan`, and shape the response before serialization. Never trust browser plan/role state.
17. Add UI component tests for live status refresh, findings summary/detail tiers, notification bell/read state, report availability, unavailable storage and terminal failure recovery.
18. Implement the assessment detail/delivery workspace for desktop/mobile with truthful loading, empty, error and local-fixture states. Keep billing and external integrations explicit when unavailable.

## Phase 5 — Reporting and private objects

19. Add sanitization and JSON export tests against `report.json@1`, including secret canaries and entitlement reductions.
20. Add PDF content tests for technical/executive required sections, limitations, untested actions and fact/inference labels.
21. Implement the reporting package and S3-compatible storage port. Use private MinIO locally and Cloudflare R2-compatible configuration in production; never public ACLs.
22. Implement short-lived single-use application download tokens stored hashed and consumed atomically after authorization. Add retention metadata and deletion hooks without enabling destructive production cleanup until its own reviewed schedule exists.

## Phase 6 — CI, OVH and completion

23. Add worker/runner image contracts to CI, production Compose validation, immutable GHCR builds, connector configuration and smoke scripts. Ensure deployment waits for readiness and keeps the old release current on failure.
24. Run workspace, unit, contract, type, lint, format, web/admin/API builds, database integration/isolation, local E2E delivery, Compose validation and all image builds. Report skips separately.
25. Update spec tasks, quickstart, README, deployment/runbook, threat model and product-journey docs with exact completed evidence and remaining external prerequisites.
26. Review the complete diff, commit coherent checkpoints, push a feature branch, open and verify the PR, merge only after all checks pass, dispatch production deploy, and validate OVH containers, logs, readiness, public edges and one non-target-contact fixture delivery check.
