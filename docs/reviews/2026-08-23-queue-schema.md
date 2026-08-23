# Queue/outbox schema boundary review

**Status:** T081 contract/schema/bootstrap slice complete and pushed with the
membership worktree. T082 owns the transactional enqueue and worker claim
implementation; until then the typed enqueue boundary fails closed with
queue_unavailable.

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
  the fixed app_private function. The placeholder function is fail-closed
  until T082 supplies the atomic job/outbox implementation.

## Evidence

Fresh database: touchmyapi_t081_queue3_test.

    bun run test:contract -- queue
    RUN_DB_TESTS=1 DATABASE_URL=..._test \
      bun run test:integration -- --maxWorkers=1 queue-schema
    bun run typecheck

Results: contract 3/3, queue schema/bootstrap integration 3/3, and strict
TypeScript passed. The integration suite checks table shape, forced RLS,
connector separation, exact standalone outbox signatures, partial active
target protection, singleton initialization, account-trigger tenant
initialization, and idempotent bootstrap updates.

No worker claims or job execution happen in T081. T082 must replace the
fail-closed placeholder before any assessment can be queued.
