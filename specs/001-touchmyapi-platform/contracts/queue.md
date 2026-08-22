# PostgreSQL Queue and Outbox Contract v1

PostgreSQL is the queue source of truth. Redis and Kafka are not required. `LISTEN/NOTIFY` is only a wake-up hint; polling and leases recover missed notifications.

## Job fields and states

Each job has `id`, `account_id`, `assessment_id`, immutable `dedupe_key`, normalized target key, `priority`, `available_at`, `status`, `attempts`, `max_attempts`, `lease_owner`, `lease_expires_at`, monotonic `fencing_token`, `stop_requested_at`, and redacted terminal reason. States are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `stale_recovered`.

A partial unique index permits one non-terminal job per `(account_id, normalized_target_key)`. Policy separately enforces one active execution per target/account and tenant/global limits.

## Claim and fencing

The worker claims inside one transaction:

```sql
SELECT id
FROM job
WHERE status = 'queued'
  AND available_at <= now()
ORDER BY fair_account_score DESC, priority DESC, available_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

The same transaction increments `fencing_token`, sets `lease_owner`, `lease_expires_at`, `started_at`, and `status='running'`, then commits before dispatch. Heartbeat, completion, failure, cancellation, and artifact writes require matching `id`, `account_id`, and fencing token; stale workers update zero rows.

Heartbeats occur before half the lease duration. The reaper marks expired leases `stale_recovered`, increments attempts, and schedules bounded exponential backoff with jitter. Exhausted attempts become `failed` with a preserved safe reason. Cancellation is idempotent and requires runner cleanup.

## Transactional outbox

Assessment/job state changes insert an `outbox_event` in the same transaction. Events have a unique `event_key`, account, aggregate, payload version, attempts, `available_at`, and processed timestamp. Consumers are at-least-once and idempotent. `NOTIFY` may wake a worker but cannot acknowledge or delete an outbox event.

## Queue operation errors

`409 active_target_conflict` is returned for a duplicate active target/account; a capacity limit leaves a job queued; stale lease writes are no-ops; exhausted retries return `failed`; policy denials return `403 policy_denied`. Error payloads never contain credentials, signed job material, raw evidence, or internal topology.
