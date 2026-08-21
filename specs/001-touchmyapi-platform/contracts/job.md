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