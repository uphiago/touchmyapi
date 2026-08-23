# Queue/outbox schema boundary review

**Status:** T081–T086 queue foundation slices are implemented on
`feat/foundation-phase2`. Tenant enqueue, fenced claim/terminal transitions,
lease recovery, fairness reconciliation, and standalone outbox operations are
now exercised against freshly migrated PostgreSQL databases. Assessment/API
integration (T027/T029/T087) remains the next gate.

## Delivered

- Queue contracts define closed statuses, enqueue input, singleton global
  capacity, tenant capacity, job operational fields, and outbox operational
  fields. Payloads and credentials are not part of the operational contracts.
- Migration 0018 adds queue_global_state, queue_tenant_state, outbox_event,
  job availability/priority/fencing/recovery fields, and the partial active
  target index for queued, stale_recovered, and running jobs.
- The migration creates queue_control as NOLOGIN/NOSUPERUSER/NOBYPASSRLS/
  NOINHERIT, plus separate queue_connector and admin_queue_connector roles.
  Queue tables use FORCE RLS; queue_connector has zero table grants and only
  fixed worker/outbox function EXECUTE grants.
- Bootstrap inserts the global singleton and backfills one tenant row for
  every active account. An account insert trigger performs the same tenant
  upsert in the account/auth transaction. The typed ensureQueueState helper
  accepts only a validated server account UUID and never selects membership.
- The typed enqueue module validates the server-derived request and calls only
  the fixed app_private function inside a transaction. PostgreSQL requires the
  matching `app.tenant` context and writes the job plus redacted outbox intent
  atomically.
- `queue-control.ts` exposes only fixed worker/outbox calls. Claim locks the
  singleton first, then the deterministic tenant/job order; leases use
  monotonic fencing tokens and stale writes are no-ops. Recovery applies
  bounded backoff without resetting fencing.
- Reconciliation repairs tenant/global running counters while deriving missing
  tenant rows only from job/outbox operational accounts. The pure scheduler
  mirrors `last_dispatched_at NULLS FIRST, account_id` and fails closed at the
  global or tenant cap.
- Outbox claim/heartbeat/ack/fail/reap use outbox-only locks and preserve
  redacted error text. The worker connector retains zero table grants and has
  no enqueue/admin function execute privilege.

## Evidence

Fresh databases: `touchmyapi_t081_queue3_test` (schema) and
`touchmyapi_t085_reconcile2_test` (queue controls).

    bun run test:contract -- queue
    RUN_DB_TESTS=1 DATABASE_URL=..._test \
      bun run test:integration -- --maxWorkers=1 queue-schema
    RUN_DB_TESTS=1 DATABASE_URL=..._test \
      bun run test:integration -- --maxWorkers=1 \
      queue-schema queue-enqueue queue-control queue-recovery \
      queue-reconcile queue-fairness outbox-control
    bun run test:unit -- fair-scheduler
    bun run typecheck

Results: contract 3/3, queue integration 10/10, scheduler unit 2/2, and strict
TypeScript passed. The queue integration suite checks atomic enqueue and
redacted outbox payloads, deterministic concurrent claims, fencing and stale
no-op terminal writes, stale lease recovery, counter reconciliation, forced
RLS/connector separation, exact standalone outbox signatures, partial active
target protection, singleton initialization, account-trigger tenant
initialization, and idempotent bootstrap updates.

The queue primitives are ready for the API and worker-control integration gate;
they do not yet dispatch a real assessment or expose an admin queue route.
