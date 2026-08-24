# PostgreSQL Queue and Outbox Contract v1

PostgreSQL is the queue source of truth. Redis and Kafka are not required. `LISTEN/NOTIFY` is only a wake-up hint; polling and leases recover missed notifications.

## Queue-control security boundary

The migration creates `queue_control` with `NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` and a separate `queue_connector` role. Functions in `app_private` are fixed-signature `SECURITY DEFINER`, owned by `queue_control`, and use `search_path = pg_catalog, app_private`. The queue connector is a worker-only connector: it receives only `EXECUTE` on worker queue and outbox functions and zero table grants. It cannot enqueue arbitrarily and never receives admin cancel, requeue, or account-reaper privileges.

| Function | Signature | Required checks |
| --- | --- | --- |
| `queue_claim` | `(text,integer,timestamptz)` | worker identity, bounded lease, global/tenant capacity |
| `queue_heartbeat` | `(uuid,uuid,text,bigint,integer,timestamptz)` | account, lease owner, fencing token, bounded extension |
| `queue_complete` | `(uuid,uuid,text,bigint,jsonb)` | account, lease owner, fencing token, safe metadata |
| `queue_fail` | `(uuid,uuid,text,bigint,text)` | account, lease owner, fencing token, redacted reason |
| `queue_reap` | `(integer,timestamptz)` | bounded batch and safe retry policy |
| `queue_reconcile` | `(integer,timestamptz)` | bounded account batch and drift repair |

Standalone outbox delivery uses these additional fixed signatures, also granted only to `queue_connector`:

| Function | Signature | Required checks |
| --- | --- | --- |
| `outbox_claim` | `(text,int,timestamptz)` | bounded batch, `pending`/eligible row, lease and monotonic fence |
| `outbox_heartbeat` | `(uuid,uuid,text,bigint,timestamptz)` | account/event, lease owner, current fence |
| `outbox_ack` | `(uuid,uuid,text,bigint,timestamptz)` | account/event, lease owner, current fence, `processing` status |
| `outbox_fail` | `(uuid,uuid,text,bigint,text,timestamptz)` | account/event, lease owner, current fence, redacted error and retry bounds |
| `outbox_reap` | `(int,timestamptz)` | bounded expired-processing batch and retry/exhaustion policy |

Outbox-only claims lock eligible rows `ORDER BY available_at, account_id, id FOR UPDATE SKIP LOCKED`; heartbeat, ack, and fail lock one row by `account_id, id`; reaping locks expired rows `ORDER BY account_id, id FOR UPDATE SKIP LOCKED`. They set/verify a lease and monotonic fencing token, retry with bounded backoff until `max_attempts`, then set terminal `failed`, `failed_at`, redacted `last_error`, and emit alert/audit. These standalone functions never lock or update `queue_global_state` or `job`. When an outbox row belongs to a job aggregate, its insert occurs in the original global→tenant→job state-change transaction; delivery still uses the standalone outbox locks.

Tenant enqueue is a separate closed typed API at `packages/db/src/queue.ts`, using `api_rls` with `set local app.tenant` after membership, policy, and entitlement checks. Its fixed `app_private.queue_enqueue(uuid,uuid,timestamptz,integer,integer)` function inserts the job and versioned, redacted outbox payload atomically. `queue_connector` has no `EXECUTE` on this function. Customer cancellation follows the same `api_rls`/policy boundary; admin cancellation, requeue, and account-scoped reaping use separate fixed `app_private.admin_queue_cancel(uuid,uuid,text,bigint,text)`, `admin_queue_requeue(uuid,uuid,text)`, and `admin_queue_reap(uuid,int,timestamptz)` functions through an `admin_queue_connector` with no table grants, only after a valid account-bound JIT capability.

The migration enables `FORCE ROW LEVEL SECURITY` on the queue tables. The singleton policy is `TO queue_control USING (id = 'global') WITH CHECK (id = 'global')`. `queue_tenant_state`, `job`, and `outbox_event` each have an explicit cross-tenant policy `TO queue_control USING (true) WITH CHECK (true)`; this is safe only because `queue_control` is `NOLOGIN`, is reachable only as the owner of fixed definer functions, and has no application connector. Generic `api_rls` policies remain `app.tenant`-scoped for customer APIs. Exact queue-control column grants are limited to `queue_global_state(id,running_count,concurrency_limit,updated_at)`, `queue_tenant_state(account_id,last_dispatched_at,running_count,concurrency_limit,updated_at)`, job operational fields `id,account_id,status,available_at,priority,attempts,max_attempts,lease_owner,lease_expires_at,fencing_token,started_at,stop_requested_at,failure_reason,created_at,normalized_target_key`, and outbox operational fields `id,account_id,event_key,aggregate_type,aggregate_id,schema_version,status,attempts,max_attempts,available_at,lease_owner,lease_expires_at,fencing_token,heartbeat_at,last_error,failed_at,processed_at,created_at`. No job payload, scope, credential, evidence, report, membership, billing, or secret columns are granted. The application uses only typed postgres.js APIs at `packages/db/src/queue.ts`, `packages/db/src/queue-control.ts`, and `packages/db/src/admin-queue.ts`; it does not construct unsafe SQL.

## Job fields and states

Each job has `id`, `account_id`, `assessment_id`, immutable `dedupe_key`, normalized target key, `priority`, `available_at`, `status`, `attempts`, `max_attempts`, `lease_owner`, `lease_expires_at`, monotonic `fencing_token`, `stop_requested_at`, and redacted terminal reason. States are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `stale_recovered`.

A partial unique index permits one active job per `(account_id, normalized_target_key)` where status is `queued`, `stale_recovered`, or `running`. Policy separately enforces tenant/global limits.

`queue_global_state` is a singleton with `id='global'`, `running_count`, and `concurrency_limit`; `queue_tenant_state` has one row for every active account. Queue bootstrap upserts the singleton; account creation/auth bootstrap upserts the tenant row in the same transaction as the account/membership write; migration backfills the singleton plus every active-account tenant row. The reconciler may create a missing tenant row only from an `account_id` already present in operational `job` or `outbox_event` rows and repairs global/tenant `running_count` drift; it does not select `account` or `account_membership`. Active-account completeness is supplied by migration and account-create/auth-bootstrap transactions. Enqueue and claim fail closed when either state row is missing or inconsistent; the job remains queued and is retried after reconciliation, so no job is silently dropped or stranded. Row locks are the only coordination mechanism: do not use advisory hash locks or `SERIALIZABLE` retry semantics.

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

Assessment/job state changes insert an `outbox_event` in the same global→tenant→job transaction. Standalone delivery uses `outbox_claim(text,int,timestamptz)`, `outbox_heartbeat(uuid,uuid,text,bigint,timestamptz)`, `outbox_ack(uuid,uuid,text,bigint,timestamptz)`, `outbox_fail(uuid,uuid,text,bigint,text,timestamptz)`, and `outbox_reap(int,timestamptz)`. Events have a unique `event_key`, account, aggregate, versioned redacted payload, `attempts`, `max_attempts`, `available_at`, `lease_owner`, `lease_expires_at`, `fencing_token`, `heartbeat_at`, `last_error`, `failed_at`, and processed timestamp. `pending` claim → `processing` requires `SKIP LOCKED` ordered by `available_at,account_id,id`; heartbeat/ack/fail require the current `account_id,id,lease_owner,fencing_token`; current-token acknowledgement → `processed`; current-token failure records redacted `last_error`, increments attempts, and returns to `pending` with bounded backoff until `max_attempts`, then transitions terminally to `failed` with `failed_at`. Expired `processing` leases follow the same retry/exhaustion path and clear the lease, with reaper order `account_id,id`. These standalone operations never touch `queue_global_state` or `job`. Terminal failure emits an alert and redacted audit event; it is never claimed again. Consumers are at-least-once and idempotent. `NOTIFY` may wake a worker but cannot acknowledge or delete an outbox event.

## Queue operation errors

`409 active_target_conflict` is returned for a duplicate active target/account; a capacity limit leaves a job queued; missing/inconsistent tenant state returns a generic `queue_unavailable` while leaving the job queued for reconciliation; stale lease writes are no-ops; exhausted retries return `failed`; policy denials return `403 policy_denied`. Error payloads never contain credentials, signed job material, raw evidence, or internal topology.
