# Data Model: TouchMyAPI Platform

**Phase 1 output** | **Date**: 2026-08-17

All business tables carry `account_id` (or an explicitly documented global/system ownership boundary) and are covered by Row-Level Security policies (default deny) per constitution III. `account` is the workspace/tenant; the existing `user` table is the single global Google identity authority and can only be reached for bootstrap/session operations through narrow functions. Runtime roles are RLS-limited; app sets tenant via `set_config('app.tenant', ...)` in a transaction with `set local role`. Timestamps are UTC `timestamptz`. IDs are either UUIDv7 (ordered, DB-friendly) or crypto-random; choose UUIDv7 for insert-heavy tables.

---

## Entities

### account

Workspace/tenant that owns all customer business data. The historical foundation starts with one account per first user; Phase 2A permits multiple users and memberships without changing the tenant key.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| status | enum | `active` / `deleted` / `revoked` |
| settings_ia_enabled | boolean | per-account external AI disable flag (V1 default true, no UI yet) |
| created_at / deleted_at | timestamptz | |

### user (global Google login identity)

The existing `user` table is the single immutable global identity authority. It is not tenant authorization and is never linked to an account by email.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| provider | enum | `google` active; `github`, `x` modeled-disabled |
| provider_subject | text | stable provider subject |
| email | citext | display/contact only; never an account key |
| created_at | timestamptz | |
| **unique** | `(provider, provider_subject)` | |

### account_membership

Explicit user-to-account authorization boundary.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id / user_id | fk | composite tenant reference; user is global |
| role | enum | `owner` / `admin` / `operator` / `viewer` / `billing` |
| status | enum | `active` / `suspended` / `removed` |
| invited_by_user_id | uuid fk | nullable for initial owner |
| created_at / updated_at / removed_at | timestamptz | |
| **unique** | `(account_id, user_id)` | one membership per user/account |

Multiple active owners are allowed. Removing or demoting the last active owner is prohibited transactionally.

### account_invitation

Single-use explicit invitation; raw token never persists.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | uuid fk | tenant |
| token_hash | text unique | SHA-256 of random token |
| email | citext | contact/display only; never used to link identity |
| proposed_role | enum | membership role |
| invited_by_user_id | uuid fk | |
| status | enum | `pending` / `accepted` / `expired` / `revoked` |
| expires_at / accepted_at / created_at | timestamptz | |
| accepted_by_user_id | uuid fk | nullable |

### session

Server-side session bound to one active account. The HttpOnly Secure cookie carries an opaque raw token; the raw cookie is never a row ID and never persists.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | server row identifier; never the raw cookie value |
| account_id | uuid fk | exactly one active account/workspace selected for this session |
| user_id | uuid fk | authenticated global `user`; composite membership reference with `account_id` |
| family_id | uuid | rotation/revocation family |
| token_hash | text unique | SHA-256 of the opaque raw cookie token; raw token never persists |
| account_session_version | bigint | changes on switch/revocation-sensitive membership change |
| expires_at / rotated_at / revoked_at | timestamptz | expiry, rotation, and revocation state |
| ip / user_agent (ua) | text | request audit metadata |

`(account_id,user_id)` has a composite foreign key to `account_membership`; no browser-selected account field is authoritative.

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
| user_id / account_id | composite fk → account_membership | attestation actor must be an active member of the assessment account |
| target_json | jsonb | snapshot of submitted scope |
| terms_version | text | version of accepted ToS/AUP |
| accepted_at | timestamptz | |

### verification

HTTP-file proof of control for a target. The schema reserves a disabled DNS-TXT method for possible future use.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | uuid fk | |
| target_json | jsonb | |
| method | enum | `http_file`; `dns_txt` is reserved but disabled pending a constitution amendment |
| challenge_token | text | >=128-bit random token |
| challenge_host | text | reserved for a future, constitution-approved TXT flow |
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
| normalized_target_key | text | canonical account target key; partial unique active-job index |
| available_at / priority | timestamptz / int | fair scheduling eligibility |
| lease_owner / lease_expires_at | text / timestamptz | SKIP LOCKED lease |
| fencing_token | bigint | monotonic claim token; required for heartbeat/result/cancel writes |
| attempts / max_attempts | int | retry with bounded backoff |
| dedupe_key | text unique | idempotency |
| failure_reason | text | redacted terminal/recovery reason |
| started_at / finished_at | timestamptz | |
| stop_requested_at | timestamptz | cancellation signal |

At most one active job exists for `(account_id, normalized_target_key)` through a partial unique index covering `queued`, `stale_recovered`, and `running`. Claims may select `queued` or `stale_recovered`; a claim sets `running` and increments `fencing_token`. Reaping changes expired `running` to `stale_recovered`, sets `available_at` with bounded backoff, and never resets the fencing token. Tenant fairness is represented by `queue_tenant_state`.

### queue_tenant_state

One row per active account used by the fair scheduler. Account creation transactionally upserts the row; migration backfill and the reconciler create missing rows for every active account.

| Field | Type | Notes |
| --- | --- | --- |
| account_id | uuid pk/fk | tenant |
| last_dispatched_at | timestamptz | nullable; `NULLS FIRST` ordering |
| running_count / concurrency_limit | int | atomically maintained and policy-capped |
| updated_at | timestamptz | reconciler/audit timestamp |

Claim locks an eligible tenant with `FOR UPDATE SKIP LOCKED`, orders by `last_dispatched_at NULLS FIRST, account_id`, checks `running_count < concurrency_limit` and global capacity, then locks the tenant's highest-priority eligible job ordered by `priority DESC, available_at, created_at, id`. It increments `running_count` and updates `last_dispatched_at` atomically. Terminal completion and reaper recovery decrement the counter; a reconciler repairs drift and creates missing state. If state is missing or inconsistent, enqueue/claim fails closed, raises an operational signal, and leaves the job queued for reconciliation rather than stranding or dropping it.

### outbox_event

Transactional account-scoped delivery intent.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | uuid fk | |
| event_key | text unique | idempotency key |
| aggregate_type / aggregate_id | text / uuid | source entity |
| schema_version | text | versioned payload contract |
| payload_json | jsonb | redacted, no secrets/raw evidence |
| status | enum | `pending` / `processing` / `processed` / `failed` |
| lease_owner / lease_expires_at | text / timestamptz | short delivery lease |
| fencing_token | bigint | monotonic outbox claim token |
| heartbeat_at | timestamptz | processing liveness |
| attempts / available_at | int / timestamptz | at-least-once delivery |
| processed_at / created_at | timestamptz | |

Rows commit with their state mutation. Outbox claim uses `FOR UPDATE SKIP LOCKED`, increments `fencing_token`, and requires the current token for acknowledgement. Expired `processing` leases return to `pending` with bounded backoff; `LISTEN/NOTIFY` is only a wake-up hint and polling/reaping is mandatory.

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

### staff_identity

Staff-only identity; never a customer membership and never authenticated by a customer session.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| external_subject | text unique | staff IdP subject, not customer provider subject |
| status | enum | `active` / `suspended` / `revoked` |
| mfa_required | boolean | always true for active staff |
| created_at / revoked_at | timestamptz | |

### staff_mfa_factor

WebAuthn MFA factor bound to a staff identity. Recovery codes are stored only as hashes.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| staff_identity_id | uuid fk | |
| credential_id / public_key | text / bytea | WebAuthn credential material |
| recovery_hash | text | one-time recovery hash only |
| status | enum | `active` / `revoked` |
| created_at / revoked_at | timestamptz | |

### staff_session

Separate admin-origin session with its own cookie and MFA freshness.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | opaque hash |
| staff_identity_id | uuid fk | |
| mfa_verified_at | timestamptz | required for sensitive operations |
| expires_at / revoked_at | timestamptz | |

### staff_role_assignment

Out-of-band staff role assignment provisioned by migration-owner CLI, keyed by immutable Google Workspace subject; domain alone is insufficient.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| staff_identity_id | uuid fk | |
| role | enum | closed staff role |
| workspace_subject | text | immutable subject, not domain-only |
| created_at / revoked_at | timestamptz | |

### support_access_grant

Just-in-time, tenant-scoped staff capability.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| account_id | uuid fk | target tenant |
| staff_identity_id | uuid fk | requester |
| capability | enum | closed policy-aware operation set |
| reason / ticket_reference | text | mandatory |
| requested_at / approved_at / expires_at | timestamptz | bounded TTL |
| approver_staff_identity_id | uuid fk | approval actor |
| status | enum | `requested` / `approved` / `expired` / `revoked` / `denied` |

No support grant permits owner/BYPASSRLS, arbitrary SQL, impersonation, secret/raw-evidence access, or billing mutation.

### support_access_approval

Approval record for a support grant. `break_glass` requires two distinct staff identities and a bounded TTL.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | |
| grant_id | uuid fk → support_access_grant | |
| approver_staff_identity_id | uuid fk | unique per grant/approver |
| approved_at | timestamptz | |

### admin_audit_event

Separate append-only staff action chain. Each tenant has its own hash chain; system/bootstrap events use the `account_id IS NULL` system boundary and never link events across tenants. Runtime admin roles may insert through the audit writer but cannot update/delete or bypass RLS.

| Field | Type | Notes |
| --- | --- | --- |
| id | uuid pk | event identifier |
| account_id | uuid fk → account | nullable only for system/bootstrap boundary |
| staff_identity_id | uuid fk → staff_identity | nullable only for system event |
| staff_session_id | uuid fk → staff_session | nullable for out-of-band bootstrap |
| grant_id | uuid fk → support_access_grant | nullable operation grant |
| approval_id | uuid fk → support_access_approval | nullable approval decision |
| request_id | text | correlation identifier |
| action | text/enum | closed admin operation vocabulary |
| subject_type / subject_id | text / uuid | safe target reference, never raw evidence |
| ticket_reference / reason | text | required for support operations |
| outcome | text/enum | `allowed` / `denied` / `error` |
| payload_json | jsonb | redacted safe metadata only |
| prev_event_hash | text | previous event hash in the same account/system chain |
| event_hash | text unique | hash of canonical event fields plus `prev_event_hash` |
| created_at | timestamptz | immutable event time |

The application enforces append-only semantics, canonical hashing, and chain continuity; security-sensitive admin mutations fail closed if this event cannot be committed.

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

- Runtime roles: `api_rls` (web/API mutations), `worker_rls` (control worker + scheduler), `reporting_rls` (read for report generation), and a separate least-privilege admin runtime role. None is owner, none has `BYPASSRLS`.
- Tables carry policy: `FOR ALL TO <role> USING (account_id = current_setting('app.tenant', true)::uuid)` with explicit deny when tenant is absent or malformed; default deny applies to membership, invitation, queue, outbox, and capability grants as well as assessment data.
- Global `user` is reachable only through fixed-purpose bootstrap functions. Playbook catalog is read-only; audit/admin audit are append-only; no runtime role gets arbitrary SQL or history deletion.
- Queue claims use `FOR UPDATE SKIP LOCKED` and compare `account_id` plus `fencing_token` on all lease/result writes. App sets `set_config('app.tenant', $1)` and `set local role` per transaction. `LISTEN/NOTIFY` never replaces polling/outbox persistence.
- Isolation is proven by `tests/isolation/` RLS tests (spec FR-003, SC-002).
