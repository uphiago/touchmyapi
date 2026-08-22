# Job Contract v1

Signed dispatch unit between control worker and runner (external sandbox or private agent). Signature ensures the runner can never execute anything outside the job (constitution IV).

## Job spec (signed at worker, verified by runner)

```jsonc
{
  "schemaVersion": "job.spec@1",
  "jobId": "uuid",
  "assessmentId": "uuid",
  "playbook": { "key": "surface-public-posture", "version": "1.0.0" },
  "target": { /* normalized target per category */ },
  "scope": {
    "inclusions": ["example.com/*"],
    "exclusions": ["mail.example.com"],
    "window": { "start": "2026-08-17T12:00:00Z", "end": "2026-08-17T12:05:00Z" }
  },
  "actions": [ /* subset of playbook actions approved by policy engine */ ],
  "limits": {
    "maxDurationS": 300,
    "maxConcurrency": 1,
    "maxRatePerMin": 10,
    "egress": { "allow": ["scope_target"], "blockDefaults": true }
  },
  "capabilities": ["http_client", "dns_resolver", "tls_probe"], // minimum, closed set
  "ttl": "2026-08-17T12:06:00Z",
  "issuedAt": "2026-08-17T12:00:00Z",
  "issuer": "worker-control",
  "signature": { "alg": "Ed25519", "value": "base64" }
}
```

## Credential channel

Credentials are NOT part of the job spec. On job start the worker mints a short-lived channel token; the runner pulls secrets over the authenticated channel and writes them to a 0600 tmpfs file for the non-root user, removed on exit. Never in env vars, argv, logs, reports, or models (spec FR-010, R6).

## Artifact manifest (runner → worker)

```jsonc
{
  "schemaVersion": "job.artifacts@1",
  "jobId": "uuid",
  "finishedAt": "2026-08-17T12:05:02Z",
  "exit": { "code": 0, "signal": null },
  "limitsUsed": { "cpuS": 12, "memMB": 84, "durationS": 62 },
  "artifacts": [
    {
      "path": "evidence/http-headers/snapshot.json",
      "sha256": "hex",
      "size": 1284,
      "kind": "json"
    }
  ],
  "output": { /* redacted, size-capped */ },
  "stopsTriggered": ["duration_exceeded"],
  "cleanup": { "containerRemoved": true, "tmpfsRemoved": true }
}
```

## Rules

- Runner refuses any action not listed in `actions` or capability outside `capabilities`.
- `ttl` and `limits` are hard caps; the sandbox kills the process on breach (fast fail, never partial).
- Evidence is produced as files with hashes; output is redacted by the runner before transmission. Internal credentials never appear in any artifact.

## PostgreSQL queue lifecycle

The signed job is created only after a PostgreSQL queue claim. A claim first locks an eligible `queue_tenant_state` row with `FOR UPDATE SKIP LOCKED`, ordered by `last_dispatched_at NULLS FIRST, account_id`, then locks that tenant's eligible `queued` or `stale_recovered` job by `priority DESC, available_at, created_at, id`. It records `accountId`, `leaseOwner`, `leaseExpiresAt`, and increments a monotonic `fencingToken`. Heartbeat, completion, failure, cancellation, and artifact acceptance include the same fencing token; a stale worker receives a no-op and cannot overwrite a newer claim. Claims are committed before dispatch.

Eligible jobs have `availableAt <= now()` and are selected by `queue_tenant_state.running_count < concurrency_limit` plus policy-reduced global capacity. A partial unique index covers `queued`, `stale_recovered`, and `running` for `(accountId, normalizedTargetKey)`. Lease expiry moves `running` to `stale_recovered`, increments attempts, and applies bounded exponential backoff with jitter. The next claim moves `stale_recovered` to `running`; exhausted attempts become `failed` with a redacted reason. Fencing is never reset; admin requeue clears lease fields and leaves the token for the next claim to increment. Terminal/reaper paths decrement the tenant counter and a reconciler repairs drift. Cancellation is idempotent and requires cleanup.

Assessment/job state transitions write an account-scoped transactional outbox event in the same database transaction. Outbox delivery is at-least-once and idempotent by event key. PostgreSQL `LISTEN/NOTIFY` may wake a poller but is never the delivery guarantee; polling recovers missed notifications. Redis and Kafka are not queue dependencies.
