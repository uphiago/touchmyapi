# Data Model: TouchMyAPI Platform

**Phase 1 output** | **Date**: 2026-08-17

All tables carry `account_id` (or an equivalent ownership column) and are covered by Row-Level Security policies (default deny) per constitution III. Runtime role is RLS-limited; app sets tenant via `set_config('app.tenant', ...)` in a transaction with `set local role`. Timestamps are UTC `timestamptz`. IDs are either UUIDv7 (ordered, DB-friendly) or crypto-random; choose UUIDv7 for insert-heavy tables.

---

## Entities

### account

Individual user account (future-proofed for organizations; the organization entity is deferred but `account_id` semantics remain).

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| status | enum | `active` / `deleted` / `revoked` |
| settings_ia_enabled | boolean | per-account external AI disable flag (V1 default true, no UI yet) |
| created_at / deleted_at | timestamptz | |

### user

Identity binding; `provider + provider_subject` immutable.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | uuid fk → account | unique where not null |
| provider | enum | `google` active; `github`, `x` modeled-disabled |
| provider_subject | text | stable subject from provider |
| email | citext | for display/contact only; never used for auto-linking |
| created_at | timestamptz | |
| **unique** | (provider, provider_subject) | |

### session

Server-side session (HttpOnly Secure cookie id → row).

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | cookie value (hashed at rest) |
| user_id | uuid fk → user | |
| rotated_at / expires_at / revoked_at | timestamptz | |
| ip / user_agent | text | audit |

### assessment

The unit of work. State machine enforced in API + policy; transitions idempotent and append-only audited.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | uuid fk | |
| target_category | enum | `web` / `api` / `surface` / `genai` / `internal` |
| target_json | jsonb | normalized target descriptor per category |
| scope_json | jsonb | inclusions, exclusions, window, contacts |
| playbook_id / playbook_version | fk / text | pinned contract + version |
| limits_json | jsonb | rate, duration, concurrency, credit estimate |
| status | enum | `draft`/`awaiting_verification`/`queued`/`running`/`analyzing`/`completed`/`failed`/`cancelled` |
| failure_reason | text | set on failed/cancelled |
| verification_ref | uuid fk → verification | for active external runs |
| credits_estimate / credits_consumed | int | catalog-driven |
| agent_id | uuid fk → agent (null for external) | internal targets only |
| created_at / updated_at | timestamptz | |

### authorization_attestation

Versioned declaration.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| assessment_id | uuid fk | |
| user_id / account_id | fk | |
| target_json | jsonb | snapshot of submitted scope |
| terms_version | text | version of accepted ToS/AUP |
| accepted_at | timestamptz | |

### verification

HTTP-file or DNS-TXT proof of control for a target.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | uuid fk | |
| target_json | jsonb | |
| method | enum | `http_file` / `dns_txt` |
| challenge_token | text | >=128-bit random token |
| challenge_host | text | `_tma-<service>-challenge.<domain>` for TXT |
| status | enum | `pending` / `verified` / `expired` / `failed` |
| verified_at / expires_at | timestamptz | re-verify on scope change |
| fetch_evidence | jsonb | sanitized fetch metadata |

### playbook

Versioned contract (in `packages/playbooks`, mirrored in DB for audit).

| Field | Type | Notes |
| --- | --- | --- |
| key | text | e.g. `surface-public-posture` |
| playbook_version | text | semantic, e.g. `1.0.0` |
| target_category | enum | |
| contract_json | jsonb | schema-validated per `packages/playbooks` |
| active | boolean | |

### job

Signed dispatch unit for the runner.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| assessment_id | uuid fk | |
| account_id | uuid fk | |
| playbook_version | text | pinned |
| job_spec_json | jsonb | signed payload: capabilities, action list, limits, target |
| status | enum | `queued`/`running`/`succeeded`/`failed`/`cancelled`/`stale_recovered` |
| lease_owner / lease_expires_at | text / timestamptz | SKIP LOCKED lease |
| attempts / max_attempts | int | retry with backoff |
| dedupe_key | text unique | idempotency |
| started_at / finished_at | timestamptz | |
| stop_requested_at | timestamptz | cancellation signal |

### runner_execution

Actual sandbox run / artifact manifest.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| job_id | uuid fk | |
| account_id | uuid fk | |
| sandbox_impl | text | e.g. `podman-rootless-runsc` |
| container_id / image_digest | text | audit |
| limits_used_json | jsonb | cpu/mem/duration observed |
| artifact_manifest_json | jsonb | file hashes, provenance |
| output_manifest_json | jsonb | redacted, size limited |
| cleaned_up | boolean | mandatory cleanup flag |
| started_at / finished_at | timestamptz | |

### credential (external)

External target test credentials, encrypted at rest, per-job delivery.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | uuid fk | |
| assessment_id | uuid fk | owns lifetime |
| encrypted_payload | bytea | AEAD (KMS/AEAD key) |
| key_id | text | for rotation |
| purpose | text | descriptive label only |
| retained_for_schedule | boolean | kept for future recurring runs, else deleted post-job |
| expires_at | timestamptz | deletion trigger |

Internal credentials: never stored (constitution IV).

### finding

Validated result with plan-gated visibility.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| assessment_id / account_id | fk | |
| title | text | |
| category / severity | enum / enum | |
| endpoint / evidence_json / repro / impact / remediation | text / jsonb / text / text / text | visibility gated by plan entitlement |
| published | boolean | |
| created_at | timestamptz | |

### report

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| assessment_id / account_id | fk | |
| kind | enum | `pdf_technical` / `pdf_executive` / `json` |
| object_key | text | private storage |
| contract_version | text | JSON schema version |
| sanitized | boolean | |
| generated_at | timestamptz | |

### credit_entry

Catalog-driven consumption.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | fk | |
| assessment_id | fk nullable | |
| credits | int | consumed or granted |
| reason | text | e.g. `playbook:surface-public-posture` |
| created_at | timestamptz | |

### billing_event

Stripe webhook record, source of truth for entitlement.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | fk | |
| stripe_event_id | text unique | dedupe key |
| type | text | e.g. `checkout.session.completed` |
| payload_minimal_json | jsonb | minimal necessary fields |
| signature_valid | boolean | |
| event_version / api_version | text | |
| processing_status | enum | `received`/`processed`/`failed` |
| result_json | jsonb | entitlement changes applied |
| received_at / processed_at | timestamptz | |

### entitlement

Plan rights derived exclusively from billing events.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | fk | |
| plan | enum | `free_unverified` / `free_verified` / `pro` / `lifetime` (one-off) |
| status | enum | `active` / `expired` / `revoked` |
| source_event_id | fk → billing_event | audit provenance |
| started_at / expires_at | timestamptz | |

### agent (private agent identity)

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | fk | |
| name | text | |
| token_hash | text | unique token (hash at rest) |
| fingerprint | text | public-key fingerprint |
| status | enum | `active`/`revoked`/`expired` |
| last_seen_at | timestamptz | |
| created_at / revoked_at | timestamptz | |

### audit_event

Append-only chained log (constitution VI).

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | monotonic |
| account_id | fk (nullable for system) | |
| assessment_id / job_id | fk nullable | |
| actor | text | user id / system / webhook |
| action | enum | request/authz/verify/policy/dispatch/runner/artifacts/analyze/publish/download/billing/delete |
| prev_event_id | uuid fk → audit_event | chained |
| payload_json | jsonb | redacted |
| created_at | timestamptz | |

### notification

In-product notification.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | fk | |
| assessment_id | fk nullable | |
| kind | text | e.g. `assessment_completed` |
| read_at | timestamptz | |
| created_at | timestamptz | |

---

## State machine (assessment)

```text
draft
  -> awaiting_verification
  -> queued
  -> running
  -> analyzing
  -> completed
  -> failed | cancelled
```

Transitions validated and idempotent in backend; cancellation sets stop signal on active job and requires runner cleanup. `awaiting_verification` is bypassed only for passive public-posture free assessments.

---

## RLS model (summary)

- Runtime roles: `api_rls` (web/API mutations), `worker_rls` (control worker + scheduler), `reporting_rls` (read for report generation). None is owner, none has `BYPASSRLS`.
- Tables carry policy: `FOR ALL TO <role> USING (account_id = current_setting('app.tenant')::uuid)`; default deny with explicit `USING` for owned rows.
- Some system-owned tables (playbook catalog, audit append) have write-only or insert-with-generated-account policies. App sets `set_config('app.tenant', $1)` and `set local role` per transaction.
- Isolation is proven by `tests/isolation/` RLS tests (spec FR-003, SC-002).