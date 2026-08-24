# Export, Webhook & Audit Contracts v1

Versioned machine-readable shapes. Schemas live in `packages/contracts`; this is the reference. JSON export carries no secrets; webhook records are the entitlement source of truth; audit is append-only and chained.

## JSON report export (versioned, plan-gated)

```jsonc
{
  "schemaVersion": "report.json@1",
  "assessmentId": "uuid",
  "generatedAt": "2026-08-17T12:10:00Z",
  "plan": "pro",
  "target": { /* normalized target */ },
  "scope": { "inclusions": [], "exclusions": [], "window": {} },
  "playbook": { "key": "surface-public-posture", "version": "1.0.0" },
  "methodology": ["...", "..."],
  "limitations": ["tests not executed", "scope limits", "inference vs fact"],
  "findings": [
    {
      "id": "uuid",
      "title": "Missing security header",
      "category": "http.headers",
      "severity": "low",
      "evidence": { /* redacted hashes, sanitized matches */ },
      "reproduction": [ /* plan-gated steps */ ],
      "impact": "low",
      "remediation": "recommendation"
    }
  ],
  "credits": { "consumed": 1, "estimate": 1 }
}
```

Rules: fields marked plan-gated (`reproduction`, full `evidence`, `impact` detail) are omitted for free-verified (only title/category/severity). Never contains credentials, tokens, internal hosts, or raw private data (spec FR-013, SC-009).

## Stripe billing event (received/processed)

```jsonc
{
  "schemaVersion": "billing@1",
  "stripeEventId": "evt_...",          // unique -> idempotency
  "type": "checkout.session.completed" // closed vocabulary
  "payloadMinimal": {                  // minimum necessary fields
    "customer": "cus_...",
    "mode": "payment" | "subscription",
    "amountTotal": 4900,
    "currency": "brl",
    "lineItems": [],
    "subscriptionId": "sub_..." | null
  },
  "processing": { "status": "processed", "result": { "plan": "pro", "credits": 10 } }
}
```

Rule: dedupe insert on `stripeEventId` BEFORE any side effect; `ON CONFLICT DO NOTHING`; re-delivery never duplicates credits (spec FR-006, SC-005). Reconciliation job sweeps for unprocessed events (audit + alert).

## Audit event (chained, append-only)

```jsonc
{
  "schemaVersion": "audit@1",
  "id": "uuid",
  "prevId": "uuid|null",               // chain
  "actor": { "kind": "user", "id": "uuid" },
  "action": "publish",                 // request|authz|verify|policy|dispatch|runner|artifacts|analyze|publish|download|billing|delete
  "subject": { "assessmentId": "uuid", "jobId": "uuid|null" },
  "payload": { /* redacted, no secrets */ },
  "createdAt": "2026-08-17T12:11:00Z"
}
```

Rule: inserted by application (append-only); account delete leaves audit rows per retention (365d). Redaction applies before write (constitution VI, spec §9).

## Membership and queue audit additions

Membership invitation creation/acceptance, role/status changes, account switching, session rotation, queue claim/heartbeat/recovery/cancel, fencing rejection, outbox delivery, and admin capability decisions use the same redacted append-only audit boundary. Payloads contain account, actor class, operation, result, request ID, grant/event/job ID, and safe reason; they never contain raw invitation tokens, credential material, signed job payloads, secrets, or raw evidence.

Admin audit additionally records staff identity, capability grant, ticket reference, reason, approval count, TTL, outcome, nullable `prev_event_hash` (NULL for the first event), and `event_hash` in an append-only per-account chain; composite account/grant and account/approval integrity is enforced, and `account_id IS NULL` is reserved for the separate system/bootstrap chain with no tenant references. Billing records remain read-only to admin; entitlement and credit changes still require verified Stripe webhooks.
