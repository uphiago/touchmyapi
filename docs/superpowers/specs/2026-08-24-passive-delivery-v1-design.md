# TouchMyAPI Passive Delivery V1 Design

**Date:** 2026-08-24

**Scope:** T106, completing the first customer delivery path from a PostgreSQL queue claim through a controlled passive execution, deterministic findings, in-product notification, plan-filtered dashboard data, and private report delivery.

## Product outcome

A customer creates and queues the authorized `surface-public-posture@1.0.0` assessment and can then leave the page. A server worker claims the job fairly, executes only the published passive actions, analyzes the bounded result, publishes the terminal state exactly once, and exposes the result through the authenticated workspace. The browser never simulates progress or unlocks detail based on local state.

The delivery states shown to the customer are `queued`, `running`, `analyzing`, and `completed`; terminal failures remain explicit and retry-safe. Completion produces an unread in-product notification. Free accounts receive the aggregate or masked fields defined by policy; paid plans receive detailed findings and private report downloads. Role checks remain independent from plan checks.

## Trust boundaries

The existing `queue_connector` remains an execute-only operational capability. It may claim, heartbeat, complete, fail, reap, and reconcile through fixed-purpose functions, but it never receives assessment payload, evidence, credentials, membership, billing, finding, or report data.

A separately provisioned `worker_connector` can set only `worker_rls`. After a queue claim returns `accountId`, the worker opens a tenant-scoped transaction and uses closed repository functions to read the immutable job input and publish results. Publication checks the claimed `jobId`, lease owner, and fencing token against the current running row before any customer-visible write. A stale worker therefore publishes nothing.

Target interaction never runs inside the queue-control process and the worker never receives a Docker socket. It submits a signed, expiring `job.spec@1` to a runner boundary. The runner accepts only catalog action identifiers and the capability list in the signed spec, uses a fresh temporary workspace, applies duration/request/response-size limits, rejects private, loopback, link-local, metadata, credential-bearing, and out-of-scope destinations before every request and redirect, emits a redacted `job.artifacts@1` manifest, and is destroyed after the job. Production fails closed when an isolated runner is unavailable; local development uses a deterministic fixture runner clearly identified in the UI and logs and never contacts a target.

## Durable lifecycle

1. `queue_claim` performs fair `FOR UPDATE SKIP LOCKED` selection and returns the tenant, lease, and fencing token.
2. Under `worker_rls`, the worker reads the assessment, attestation, playbook and job spec, re-evaluates policy, and transitions the assessment to `running` only when the current lease matches.
3. The control worker signs and dispatches the reduced spec. Heartbeats renew the lease while the runner is active.
4. Deterministic analysis converts only validated manifest facts into stable findings. Target content is data, never instructions.
5. A fenced tenant transaction moves the assessment through `analyzing`, upserts findings/reports by stable source key, inserts one completion notification, records runner cleanup and appends the audit event.
6. `queue_complete` releases capacity. If the process dies between publication and completion, retry sees the same deterministic result keys and performs no duplicate customer delivery.
7. Failure uses a redacted bounded reason, never raw output, and terminal state is reflected in the assessment. Reaper/reconciliation remain the recovery authority.

## Findings and entitlement filtering

The database stores the complete sanitized finding. API serialization applies `rightsForPlan` on every read:

- `aggregate`: assessment totals by severity and category; no finding rows.
- `masked`: title, category, and severity only.
- `detailed`: endpoint, redacted evidence, impact, reproduction and remediation.

The plan is resolved server-side from entitlement state with `free_unverified` as the fail-closed baseline. Membership controls who may read or mutate; plan rights only reduce the payload. IDs from another account remain indistinguishable from missing IDs under RLS.

## Reports and storage

Report input is sanitized before any JSON or PDF renderer sees it. JSON follows `report.json@1`; technical and executive PDFs explicitly include scope, methodology, limitations, untested actions, fact-versus-inference labels, severity, impact and remediation permitted by the plan.

Objects use deterministic account/assessment/report keys in a private S3-compatible bucket. The API never proxies an unrestricted object and never exposes permanent object URLs. It validates membership, ownership and plan, then returns a short-lived single-use application download token; the server performs the private object read. Local development uses private MinIO. Production storage remains fail-closed until valid credentials and a private bucket pass readiness; it never falls back to an in-memory or public mock.

## Services and deployment

The release adds independently health-checked worker-control and runner artifacts. GitHub Actions builds immutable images, validates their container contracts, runs unit/contract/database/isolation tests, deploys migrations and least-privilege connectors first, starts the new services, and executes a credential-free local delivery smoke plus production liveness/readiness checks. The OVH deploy retains the previous release metadata and does not mark a release current until queue, worker, API, storage and public-edge checks pass.

## Failure behavior

- No runner, invalid signature, policy drift, storage failure, stale fence, oversized output, scope escape, redirect escape or cleanup failure fails closed.
- Findings and reports are never published from a partially validated manifest.
- Completion notification is unique per assessment terminal transition.
- External notification integrations remain non-functional placeholders.
- Production does not use fixture execution, public storage, browser-generated findings, or migration-owner database credentials.

## Acceptance evidence

The milestone is complete only when tests prove fencing/no stale publication, idempotent retry, two-account isolation, plan-filtered serialization, report redaction and private downloads, redirect/DNS rebinding defenses, runner cleanup, queue recovery, browser walkthrough, Compose configuration, immutable image builds, and an OVH post-deploy smoke. Any unavailable external prerequisite stays visibly open in tasks and readiness; it is never represented as a successful delivery.
