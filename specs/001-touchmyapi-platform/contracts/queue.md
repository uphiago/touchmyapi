# PostgreSQL Queue and Outbox Contract v1

PostgreSQL is the queue source of truth. Redis and Kafka are not required. `LISTEN/NOTIFY` is only a wake-up hint; polling and leases recover missed notifications.

## Job fields and states

Each job has `id`, `account_id`, `assessment_id`, immutable `dedupe_key`, normalized target key, `priority`, `available_at`, `status`, `attempts`, `max_attempts`, `lease_owner`, `lease_expires_at`, monotonic `fencing_token`, `stop_requested_at`, and redacted terminal reason. States are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `stale_recovered`.

A partial unique index permits one active job per `(account_id, normalized_target_key)` where status is `queued`, `stale_recovered`, or `running`. Policy separately enforces tenant/global limits.

## Claim and fencing

The worker claims inside one transaction:

```sql
SELECT account_id
FROM queue_tenant_state
WHERE running_count < concurrency_limit
  AND EXISTS (
    SELECT 1 FROM job
    WHERE job.account_id = queue_tenant_state.account_id
      AND job.status IN ('queued', 'stale_recovered')
      AND job.available_at <= now()
  )
ORDER BY last_dispatched_at NULLS FIRST, account_id
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

After locking the tenant row, the same transaction locks its highest-priority eligible job with `priority DESC, available_at, created_at, id FOR UPDATE SKIP LOCKED`, checks global capacity, increments `fencing_token`, sets `lease_owner`, `lease_expires_at`, `started_at`, and `status='running'`, increments `running_count`, and updates `last_dispatched_at`. The fencing token is never reset; admin requeue clears lease fields but leaves the token for the next claim to increment. The transaction commits before dispatch. Heartbeat, completion, failure, cancellation, and artifact writes require matching `id`, `account_id`, and fencing token; stale workers update zero rows. Terminal completion and reaper recovery decrement `running_count`; a reconciler repairs drift.

Heartbeats occur before half the lease duration. The reaper changes expired `running` jobs to `stale_recovered`, increments attempts, sets `available_at` using bounded exponential backoff with jitter, and preserves the safe reason. The next claim accepts `stale_recovered` and changes it to `running`; exhausted attempts become `failed`. Cancellation is idempotent and requires runner cleanup.

## Transactional outbox

Assessment/job state changes insert an `outbox_event` in the same transaction. Events have a unique `event_key`, account, aggregate, payload version, attempts, `available_at`, `lease_owner`, `lease_expires_at`, `fencing_token`, `heartbeat_at`, and processed timestamp. Outbox claim uses `FOR UPDATE SKIP LOCKED`; expired `processing` leases return to `pending` with bounded backoff, and acknowledgement requires the current fencing token. Consumers are at-least-once and idempotent. `NOTIFY` may wake a worker but cannot acknowledge or delete an outbox event.

## Queue operation errors

`409 active_target_conflict` is returned for a duplicate active target/account; a capacity limit leaves a job queued; stale lease writes are no-ops; exhausted retries return `failed`; policy denials return `403 policy_denied`. Error payloads never contain credentials, signed job material, raw evidence, or internal topology.
