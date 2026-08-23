# PostgreSQL Queue and Outbox Contract v1

PostgreSQL is the queue source of truth. Redis and Kafka are not required. `LISTEN/NOTIFY` is only a wake-up hint; polling and leases recover missed notifications.

## Queue-control security boundary

The migration creates `queue_control` with `NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` and a separate `queue_connector` role. Functions in `app_private` are fixed-signature `SECURITY DEFINER`, owned by `queue_control`, and use `search_path = pg_catalog, app_private`. `queue_connector` receives only `EXECUTE` on these functions and zero table grants:

| Function | Signature | Required checks |
| --- | --- | --- |
| `queue_enqueue` | `(uuid,uuid,timestamptz,integer,integer)` | account/job match, active state, policy-reduced priority/attempt bounds |
| `queue_claim` | `(text,integer,timestamptz)` | worker identity, bounded lease, global/tenant capacity |
| `queue_heartbeat` | `(uuid,uuid,text,bigint,integer,timestamptz)` | account, lease owner, fencing token, bounded extension |
| `queue_complete` | `(uuid,uuid,text,bigint,jsonb)` | account, lease owner, fencing token, safe metadata |
| `queue_fail` | `(uuid,uuid,text,bigint,text)` | account, lease owner, fencing token, redacted reason |
| `queue_cancel` | `(uuid,uuid,text,bigint,text)` | account, lease owner, fencing token, safe reason |
| `queue_requeue` | `(uuid,uuid,text)` | account, policy grant, bounded reason; fencing is preserved |
| `queue_reap` | `(integer,timestamptz)` | bounded batch and safe retry policy |
| `queue_reconcile` | `(integer,timestamptz)` | bounded account batch and drift repair |

Direct privileges and RLS are limited to `queue_global_state`, `queue_tenant_state`, and required operational metadata/state columns of `job` and `outbox_event`. Job specifications, scopes, credentials, evidence, reports, billing, membership, and all other business tables are inaccessible. Cross-account scheduling is allowed only inside these bounded functions; there is no owner, `BYPASSRLS`, arbitrary SQL, or direct table path. The application uses only the typed postgres.js API at `packages/db/src/queue-control.ts`; it does not construct unsafe SQL.

## Job fields and states

Each job has `id`, `account_id`, `assessment_id`, immutable `dedupe_key`, normalized target key, `priority`, `available_at`, `status`, `attempts`, `max_attempts`, `lease_owner`, `lease_expires_at`, monotonic `fencing_token`, `stop_requested_at`, and redacted terminal reason. States are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `stale_recovered`.

A partial unique index permits one active job per `(account_id, normalized_target_key)` where status is `queued`, `stale_recovered`, or `running`. Policy separately enforces tenant/global limits.

`queue_global_state` is a singleton with `id='global'`, `running_count`, and `concurrency_limit`; `queue_tenant_state` has one row for every active account. Queue bootstrap upserts the singleton; account creation/auth bootstrap upserts the tenant row in the same transaction as the account/membership write; migration backfills the singleton plus every active-account tenant row; and the reconciler creates missing rows and repairs global/tenant `running_count` drift. Enqueue and claim fail closed when either state row is missing or inconsistent; the job remains queued and is retried after reconciliation, so no job is silently dropped or stranded. Row locks are the only coordination mechanism: do not use advisory hash locks or `SERIALIZABLE` retry semantics.

## Claim and fencing

The worker claims inside one transaction, with lock order global → tenant → job:

```sql
SELECT id, running_count, concurrency_limit
FROM queue_global_state
WHERE id = 'global'
FOR UPDATE;
```

If the global row is missing or `running_count >= concurrency_limit`, the claim fails closed and leaves jobs queued. Otherwise it locks an eligible tenant:

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

After locking the tenant row, the same transaction locks its highest-priority eligible job with `priority DESC, available_at, created_at, id FOR UPDATE SKIP LOCKED`, checks global and tenant capacity, increments `fencing_token`, sets `lease_owner`, `lease_expires_at`, `started_at`, and `status='running'`, and increments both global and tenant `running_count` while updating `last_dispatched_at`. The fencing token is never reset; admin requeue clears lease fields but leaves the token for the next claim to increment. The transaction commits before dispatch. Heartbeat, completion, failure, cancellation, and artifact writes require matching `id`, `account_id`, and fencing token; stale workers update zero rows. Terminal completion and reaper recovery decrement both counters; a reconciler repairs drift and missing state.

Completion, heartbeat, failure, cancellation, and requeue use the same transaction order global `FOR UPDATE` → identified tenant `FOR UPDATE` → identified job `FOR UPDATE`; a stale fencing predicate is a no-op and never changes counters. Reaper and reconciliation use global `FOR UPDATE`, then tenants `ORDER BY account_id FOR UPDATE SKIP LOCKED`, then jobs `ORDER BY id FOR UPDATE SKIP LOCKED`. All counter changes and row state transitions commit together.

Heartbeats occur before half the lease duration. The reaper changes expired `running` jobs to `stale_recovered`, increments attempts, sets `available_at` using bounded exponential backoff with jitter, and preserves the safe reason. The next claim accepts `stale_recovered` and changes it to `running`; exhausted attempts become `failed`. Cancellation is idempotent and requires runner cleanup.

## Transactional outbox

Assessment/job state changes insert an `outbox_event` in the same transaction. Events have a unique `event_key`, account, aggregate, payload version, `attempts`, `max_attempts`, `available_at`, `lease_owner`, `lease_expires_at`, `fencing_token`, `heartbeat_at`, `last_error`, `failed_at`, and processed timestamp. `pending` claim → `processing` requires `SKIP LOCKED`; current-token acknowledgement → `processed`; current-token failure records redacted `last_error`, increments attempts, and returns to `pending` with bounded backoff until `max_attempts`, then transitions terminally to `failed` with `failed_at`. Expired `processing` leases follow the same retry/exhaustion path and clear the lease. Terminal failure emits an alert and redacted audit event; it is never claimed again. Consumers are at-least-once and idempotent. `NOTIFY` may wake a worker but cannot acknowledge or delete an outbox event.

## Queue operation errors

`409 active_target_conflict` is returned for a duplicate active target/account; a capacity limit leaves a job queued; missing/inconsistent tenant state returns a generic `queue_unavailable` while leaving the job queued for reconciliation; stale lease writes are no-ops; exhausted retries return `failed`; policy denials return `403 policy_denied`. Error payloads never contain credentials, signed job material, raw evidence, or internal topology.
