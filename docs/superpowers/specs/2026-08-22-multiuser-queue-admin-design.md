# TouchMyAPI Multi-user, PostgreSQL Queue and Admin Control Plane Design

**Date:** 2026-08-22
**Status:** Approved for implementation after T021
**Supersedes:** the launch-time individual-account assumption only for this future extension; it does not change the historical Foundation Phase 2 non-goal.
**Normative decision:** Alternative B

## Goal and scope

This extension adds shared accounts/workspaces, explicit membership, invitation, a PostgreSQL source-of-truth queue, and a separately isolated administrative control plane. It preserves the existing authorization, policy-engine, RLS, runner, AI, billing, and webhook principles. Google remains the only customer login at launch. SSO, SCIM, customer webhooks, and provider-specific directory sync remain out of scope.

The word `account` is the tenant boundary. The UI may call it a workspace or organization, but all business rows and policy decisions use `account_id`. A Google identity is global and immutable; access to an account exists only through an explicit `account_membership` row. Email is display/contact data and is never an automatic account link.

## Alternatives considered

### Alternative A — global user with account columns

Keep one `user.account_id` and add an optional list of account IDs in application state. This is the smallest schema change, but it makes multi-membership, invitation acceptance, session switching, billing ownership, and RLS difficult to prove. A missed application check can expose another account, and membership history has no first-class audit row. Rejected because it violates the default-deny design objective.

### Alternative B — account/workspace tenant with explicit membership (recommended)

Keep `identity` global (`provider + provider_subject`), model `account` as the tenant, and use `account_membership` for role and status. Invitations contain only a hash of a random token and an explicitly named destination email; acceptance resolves the authenticated global identity and never auto-links by email. The active account is a server-side session claim, and switching accounts rotates the session. This gives direct RLS predicates, deterministic authorization, auditable role changes, and a clean future path to more identity providers.

### Alternative C — separate organization service and external queue

Move organization/membership to a service and use Redis/Kafka for dispatch. This can scale independently, but duplicates tenant policy, introduces a second source of truth, and creates delivery/fencing semantics that still need PostgreSQL transactions. It also expands the trust boundary before the product has queue metrics and recovery proof. Rejected for this phase; PostgreSQL remains the source of truth and Redis/Kafka are not required.

## Recommended architecture

### Identity and membership

* `identity` is global and keyed by immutable `(provider, provider_subject)`. It stores no tenant business data.
* `account` is the tenant/workspace and owns billing, targets, assessments, jobs, findings, evidence, reports, schedules, invitations, memberships, and outbox rows.
* `account_membership` has `owner | admin | operator | viewer | billing`, `active | suspended | removed` status, timestamps, and an audit actor. A membership is unique per `(account_id, identity_id)` and only one active owner is permitted by policy.
* `account_invitation` stores `token_hash`, `account_id`, destination `email`, proposed role, inviter identity, expiry, single-use status, and acceptance metadata. The raw token is displayed once, never persisted or logged. A signed-in identity must explicitly accept; equal email is not sufficient to link an identity.
* `session` stores the active `account_id`, global identity ID, opaque token hash, rotation/revocation timestamps, and an active-account version. Login creates the first account and owner membership. Account switching validates membership, revokes the old session, and issues a new session; it never mutates a browser-only tenant selector.

RLS applies to every business row. Global identity lookup is limited to fixed bootstrap functions for OAuth login, session resolution, and explicit invitation acceptance. No request can select a global identity and then choose an arbitrary account.

### Queue and outbox

`job` is the durable queue row and remains account-scoped. Its immutable `dedupe_key`, `available_at`, `priority`, `attempts`, `max_attempts`, `lease_owner`, `lease_expires_at`, `fencing_token`, and terminal reason are the source of truth. A partial unique index permits at most one non-terminal job for the same `(account_id, normalized_target_key)`; a separate policy limit enforces one active execution per target/account.

Claim transaction:

1. Select eligible jobs by fair account scheduling, `available_at <= now()`, and policy capacity using `FOR UPDATE SKIP LOCKED`.
2. Increment `fencing_token`, set `lease_owner`, `lease_expires_at`, `started_at`, and `status=running` in the same transaction.
3. Commit the claim before dispatch. Every heartbeat, result, cancellation, and artifact write includes the fencing token; stale workers affect zero rows.

The worker heartbeats before half the lease duration and extends only its matching lease. A reaper marks expired leases as `stale_recovered`, increments attempts, and schedules bounded exponential backoff with jitter; exhausted attempts become `failed` with a preserved reason. Cancellation sets `stop_requested_at` and is idempotent. A timeout is a policy decision and still requires runner cleanup.

Fair scheduling uses a per-account active count and a rotating/deficit score, then applies tenant and global limits. A noisy account cannot consume all global slots. Limits are policy reductions, not user input. `LISTEN/NOTIFY` is an optional wake-up hint; a polling loop always recovers missed notifications. An `outbox_event` is inserted transactionally with each state change and has a unique event key, delivery attempts, `available_at`, and processed timestamp. Outbox delivery is at-least-once and idempotent.

### Admin control plane

The admin app has its own origin, API base path, CSRF protection, cookies, and staff identity tables. Staff identity is not a customer membership and customer OAuth cannot log into it. MFA is required for every staff session; sensitive actions require recent MFA. There is no impersonation feature and no `owner`/`BYPASSRLS` path.

Tenant support uses a just-in-time `capability_grant` with `staff_identity_id`, `account_id`, closed capability enum, reason, ticket reference, requested/approved timestamps, expiry, and approver identity. Grants are denied by default, tenant-scoped, short-lived, and audited. Break-glass capabilities require two distinct approvers and a bounded TTL. Admin queue operations call the same policy engine and may inspect metadata/status/reasons, cancel or requeue within policy, and trigger a reaper; they cannot execute arbitrary jobs, alter scope, read secrets/raw evidence, or bypass billing webhooks. Billing is read-only.

## Data flows

### Login, invite, and account switch

1. Google callback resolves/creates the global identity through the narrow bootstrap function.
2. If no membership exists, the first account and owner membership are created atomically; otherwise the user chooses an active account from existing memberships.
3. An owner/admin creates an invitation. The API stores only a token hash and sends the raw token through the configured delivery boundary; the invitation endpoint never auto-links by email.
4. The authenticated recipient presents the token and explicitly accepts a proposed role. The transaction locks the invitation, verifies expiry/status/hash, verifies identity and account policy, inserts membership, marks the invitation used, rotates the session to that account, and appends audit events.
5. Account switch repeats membership authorization and rotates the session, invalidating the previous active-account claim.

### Assessment dispatch

The existing assessment state transition and policy decision create a job and an outbox event in one account-scoped transaction. The worker claims it with `SKIP LOCKED` and a fencing token, obtains a policy-reduced signed job specification, and dispatches to the isolated runner. Runner completion is accepted only when job ID, account ID, and fencing token match. Findings, reports, credits, and notifications remain account-scoped.

### Admin operation

The admin UI authenticates staff separately, requests a capability grant with reason and ticket, and requires approval. The API evaluates the grant, staff MFA freshness, tenant policy, and operation-specific policy before a transaction. Every read/write records staff actor, account, capability, ticket, reason, outcome, and grant ID; raw evidence and secrets are never included.

## Error and recovery behavior

| Condition | Contract result |
| --- | --- |
| Invitation token missing, expired, reused, or hash mismatch | `404` generic invalid invitation; no existence oracle; no membership change |
| Recipient has same email but no explicit authenticated acceptance | `403` explicit acceptance required; no auto-link |
| Account switch without active membership | `403` and old session remains valid for its current account |
| Stale session after switch/revocation | `401`; require fresh login; no tenant fallback |
| Duplicate membership/invitation acceptance | Idempotent result for the same operation, otherwise `409`; audit records the decision |
| Queue claim loses lease/fencing token | Write affects zero rows; stale worker is stopped and reaped |
| Worker crash or missed notification | Lease expiry/reaper and polling recover the job; `NOTIFY` loss cannot lose work |
| Retry budget exhausted | Terminal `failed` with redacted reason, audit event, and no automatic scope expansion |
| Tenant/global limit reached | Job remains queued with `available_at` and fair scheduling; no busy spin |
| Admin grant absent/expired/not approved | `403`; no fallback capability |
| Break-glass missing second approver | `403`; no partial activation |
| Admin requests secret/raw evidence/arbitrary SQL/impersonation | `403`, audit security event, no query or artifact access |

## Security invariants

1. All business queries run under a non-owner, non-`BYPASSRLS` role with `app.tenant=account_id`; membership itself is the authorization input, not an ID in a URL.
2. Global identity functions have fixed signatures and cannot perform arbitrary search, email linking, or cross-account joins.
3. Session cookies are separate for customer and admin origins. Active account is server-side, rotated on login/switch/role-sensitive change, and revocable.
4. Invitation tokens are random, single-use, expiry-bound, hash-only at rest, and redacted from logs/audit.
5. Queue claims, heartbeat, completion, cancellation, and reaping require the current fencing token. Every mutation is idempotent and audited.
6. Policy engine remains final authority for target, scope, entitlement, action, rate, duration, concurrency, and admin queue operation. Admin does not become a policy bypass.
7. Queue metadata may be visible to authorized staff under a grant; credentials, secret payloads, raw evidence, runner authorizations, and private keys never are.
8. Stripe webhooks remain the only entitlement/billing state change. Admin may read billing status and event processing results but cannot grant credits or plans.
9. No Redis, Kafka, arbitrary SQL, customer impersonation, SSO, SCIM, or inbound private-agent connection is introduced.

## Testing and proof

Tests are TDD and must run after T021 with the membership slice before T022. Required proof includes:

* two identities in one account with each role's allow/deny matrix;
* identity with two accounts, explicit account switch, session rotation, and old-session revocation;
* invitation token hash/expiry/single-use, wrong identity, duplicate acceptance, and email non-linking;
* RLS isolation for membership, invitation, queue, outbox, and admin grant rows, including missing tenant context;
* concurrent claims prove `SKIP LOCKED` prevents duplicate claim and fencing blocks stale completion;
* heartbeat, retry/backoff, lease expiry/reaper, cancellation, timeout, fairness, tenant/global limits, and outbox idempotency;
* admin MFA, separate cookie/origin, JIT reason/ticket/TTL/approval, dual break-glass, no impersonation, no owner/BYPASSRLS/arbitrary SQL, no secrets/raw evidence, read-only billing, and policy-aware queue operations;
* migration backfill and cutover tests prove legacy one-user accounts receive one owner membership and no user gains another account.

## Migration and cutover

Migration is additive and reversible until the enforcement switch:

1. Add `identity_id`/`account_id` constraints and new membership, invitation, outbox, and admin tables; preserve existing rows.
2. Backfill one `account_membership(owner)` per existing account/user, using immutable provider subject. Rows without a valid identity are quarantined for explicit support resolution, never matched by email.
3. Backfill queue keys and `fencing_token=0`; create partial unique indexes concurrently after duplicate jobs are resolved by an audited policy decision.
4. Deploy dual-read authorization (legacy owner check plus membership) and write audit events for both outcomes. Verify RLS isolation and queue recovery in staging.
5. Switch reads/mutations to membership and active-account sessions; rotate sessions at first request and invalidate legacy tenant selectors.
6. Enable admin origin/MFA and JIT grants only after staff identities and approval records exist. Remove legacy owner-only paths after retention and review.

Rollback before step 5 disables new invitation/admin routes and reverts reads to the legacy path while preserving additive rows. After step 5, rollback is a forward migration: revoke new sessions, preserve membership/audit history, and correct access through explicit membership changes; never delete audit or queue history.

## Non-goals

This phase does not add SSO, SCIM, customer webhooks, arbitrary SQL, impersonation, owner/BYPASSRLS runtime access, admin access to secrets/raw evidence, billing writes, a new queue broker, or active assessment behavior. The Foundation Phase 2 historical non-goal remains valid; this document is a future extension to execute after T021.

## Acceptance criteria

* A global Google identity can access an account only through an active membership; email equality never creates a link.
* Roles enforce owner/admin/operator/viewer/billing capabilities in API and RLS, with explicit invite acceptance and auditable changes.
* Account switch rotates and revokes sessions; every customer request has one server-selected active account.
* PostgreSQL is the queue source of truth. Concurrent workers claim distinct jobs with `SKIP LOCKED`; fencing, heartbeat, retry/backoff, reaper, fairness, and tenant/global limits are proven.
* State changes and outbox rows commit atomically; missed `NOTIFY` cannot lose work and duplicate delivery is harmless.
* Admin uses separate staff identity/origin/cookies and MFA; JIT capability grants and dual-approved break-glass are TTL-bound and audited.
* Admin cannot impersonate, bypass RLS, run arbitrary SQL, read secrets/raw evidence, or mutate billing/entitlement.
* Existing FR-001–FR-021, SC-001–SC-010, and Constitution I–VI remain satisfied; new traceability is recorded in the Phase 2A tasks and contracts.
