# TouchMyAPI Multi-user, PostgreSQL Queue and Admin Control Plane Design

**Date:** 2026-08-22
**Status:** Approved for implementation after T021
**Supersedes:** the launch-time individual-account assumption only for this future extension; it does not change the historical Foundation Phase 2 non-goal.
**Normative decision:** Alternative B

## Goal and scope

This extension adds shared accounts/workspaces, explicit membership, invitation, a PostgreSQL source-of-truth queue, and a separately isolated administrative control plane. It preserves the existing authorization, policy-engine, RLS, runner, AI, billing, and webhook principles. Google remains the only customer login at launch. SSO, SCIM, customer webhooks, and provider-specific directory sync remain out of scope.

The word `account` is the tenant boundary. The UI may call it a workspace or organization, but all business rows and policy decisions use `account_id`. The existing `user` table is the single global immutable Google identity authority; access to an account exists only through `account_membership(account_id,user_id)`. Email is delivery/contact data and is never an automatic account link.

## Alternatives considered

### Alternative A — global user with account columns

Keep one `user.account_id` and add an optional list of account IDs in application state. This is the smallest schema change, but it makes multi-membership, invitation acceptance, session switching, billing ownership, and RLS difficult to prove. A missed application check can expose another account, and membership history has no first-class audit row. Rejected because it violates the default-deny design objective.

### Alternative B — account/workspace tenant with explicit membership (recommended)

Keep the existing `user` table global (`provider + provider_subject`), model `account` as the tenant, and use `account_membership(account_id,user_id)` for role and status. Invitations contain only a hash of a 256-bit bearer token and delivery email; acceptance resolves the authenticated user from the session and never auto-links by email. The active account is `session.account_id`, and switching accounts rotates the session. This gives direct RLS predicates, deterministic authorization, auditable role changes, and a clean future path to more providers without a second identity authority.

### Alternative C — separate organization service and external queue

Move organization/membership to a service and use Redis/Kafka for dispatch. This can scale independently, but duplicates tenant policy, introduces a second source of truth, and creates delivery/fencing semantics that still need PostgreSQL transactions. It also expands the trust boundary before the product has queue metrics and recovery proof. Rejected for this phase; PostgreSQL remains the source of truth and Redis/Kafka are not required.

## Recommended architecture

### Identity and membership

* `user` is global and keyed by immutable `(provider, provider_subject)`. It is the only customer identity table and stores no tenant business authorization.
* `account` is the tenant/workspace and owns billing, targets, assessments, jobs, findings, evidence, reports, schedules, invitations, memberships, and outbox rows.
* `account_membership` has `owner | admin | operator | viewer | billing`, `active | suspended | removed` status, timestamps, and an audit actor. A membership is unique per `(account_id, user_id)`. Multiple active owners are allowed; a transaction must reject removal/demotion of the last active owner.
* `account_invitation` stores `token_hash`, `account_id`, delivery `email`, proposed role, inviter `user_id`, expiry, single-use status, `accepted_by_user_id`, and acceptance metadata. The 256-bit raw bearer token is displayed once, never persisted, placed in a URL, or logged. A signed-in user must explicitly accept; equal email is not sufficient to link a user.
* `session` stores `account_id`, `user_id`, opaque token hash, rotation/revocation timestamps, and an account-session version. Login creates the first account and owner membership. Account switching validates membership through a narrow function, revokes the old session, and issues a new session; it never mutates a browser-only tenant selector.

RLS applies to every business row. Narrow bootstrap functions are explicit: `auth_complete_google_login`, `auth_resolve_session`, `auth_list_accounts(session_hash)`, `auth_switch_account(current_hash,target_account_id,new_hash,expiry)`, and `auth_revoke_session`. They use fixed search paths, are executable only by `auth_bootstrap`, never look up by email, and cannot perform arbitrary cross-account enumeration.

### Queue and outbox

`job` is the durable queue row and remains account-scoped. Its immutable `dedupe_key`, `available_at`, `priority`, `attempts`, `max_attempts`, `lease_owner`, `lease_expires_at`, `fencing_token`, and terminal reason are the source of truth. A partial unique index permits at most one active job for `(account_id, normalized_target_key)` where status is `queued`, `stale_recovered`, or `running`.

`queue_global_state(id='global',running_count,concurrency_limit)` is a singleton global capacity row, and `queue_tenant_state(account_id,last_dispatched_at,running_count,concurrency_limit)` is the exact fairness state. Queue bootstrap upserts the singleton; account creation/auth bootstrap transactionally upserts its tenant state; migration backfills the singleton plus a tenant row for every active account; and the reconciler creates missing tenant rows only from operational `job`/`outbox_event` account IDs and repairs global/tenant drift without selecting `account` or `account_membership`. Active-account completeness comes from migration and account-create/auth-bootstrap. Claims lock global `FOR UPDATE`, then tenant `FOR UPDATE SKIP LOCKED`, then job `FOR UPDATE SKIP LOCKED` (global→tenant→job); no advisory hash locks or `SERIALIZABLE` retries are used. If state is missing or inconsistent, enqueue/claim fails closed while leaving jobs queued for reconciliation; no job is dropped or stranded.

Claim transaction:

1. Lock `queue_global_state` with `FOR UPDATE`; if the singleton is missing or global capacity is full, fail closed and leave jobs queued.
2. Select an eligible tenant where `running_count < concurrency_limit` and an eligible job exists (`status IN ('queued','stale_recovered')`, `available_at <= now()`) by locking `queue_tenant_state` with `FOR UPDATE SKIP LOCKED`, ordered by `last_dispatched_at NULLS FIRST, account_id`.
3. Lock that tenant's highest-priority eligible job with `FOR UPDATE SKIP LOCKED`, ordered by `priority DESC, available_at, created_at, id`, and check global capacity again under the global row lock.
4. Increment `fencing_token`, set `lease_owner`, `lease_expires_at`, `started_at`, `status=running`, increment global and tenant `running_count`, and update `last_dispatched_at` atomically. Commit before dispatch.
5. Every heartbeat, result, cancellation, and artifact write includes the fencing token; stale workers affect zero rows. The fencing token is never reset.

The worker heartbeats before half the lease duration and extends only its matching lease. A reaper changes expired `running` leases to `stale_recovered`, increments attempts, sets `available_at` with bounded exponential backoff and jitter, and decrements global and tenant `running_count`; the next claim changes `stale_recovered` to `running`. Exhausted attempts become `failed` with a preserved reason. Cancellation sets `stop_requested_at` and is idempotent. A timeout is a policy decision and still requires runner cleanup. Admin requeue clears lease fields but preserves the fencing token; the next claim increments it. The reconciler repairs both counters.

Fair scheduling uses `queue_global_state` plus `queue_tenant_state`: global lock first, tenant order `last_dispatched_at NULLS FIRST, account_id`, and job order `priority DESC, available_at, created_at, id`. A noisy account cannot consume all global slots. Limits are policy reductions, not user input. Tenant enqueue is performed by closed typed `packages/db/src/queue.ts` under `api_rls`/`app.tenant` after membership, policy, and entitlement checks, and inserts the job plus a versioned redacted outbox payload atomically. `LISTEN/NOTIFY` is an optional wake-up hint; a polling loop and reaper recover missed notifications. A job-aggregate `outbox_event` is inserted in the original global→tenant→job transaction; standalone delivery has a unique event key, delivery attempts/max attempts, short lease, lease owner, lease expiry, fencing token, heartbeat, redacted last error, failed timestamp, and processed timestamp. Standalone outbox claims lock `available_at,account_id,id`; heartbeat/ack/fail/reap lock `account_id,id`; these functions never touch `queue_global_state` or `job`. Outbox transitions are `pending`→`processing`→`processed`; current-token failure or expired processing retries with bounded backoff, then becomes terminal `failed`, emits alert/audit, and is never claimed again. Outbox delivery is at-least-once and idempotent.

#### Queue control database boundary

The generated migration creates role `queue_control` with `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, and `NOINHERIT`, plus a separate worker-only `queue_connector` service role with no direct table privileges. Functions in `app_private` are `SECURITY DEFINER`, owned by `queue_control`, and set `search_path = pg_catalog, app_private` in their definitions. `queue_connector` receives only `EXECUTE` on worker queue/outbox signatures and zero table grants; it cannot enqueue or execute admin functions:

| Function signature | Purpose |
| --- | --- |
| `app_private.queue_claim(text,integer,timestamptz)` | claim one eligible job and return its fencing lease |
| `app_private.queue_heartbeat(uuid,uuid,text,bigint,integer,timestamptz)` | extend a current lease |
| `app_private.queue_complete(uuid,uuid,text,bigint,jsonb)` | accept a current-fence terminal success with safe metadata |
| `app_private.queue_fail(uuid,uuid,text,bigint,text)` | accept a current-fence failure with redacted reason |
| `app_private.queue_reap(integer,timestamptz)` | recover a bounded batch of expired leases |
| `app_private.queue_reconcile(integer,timestamptz)` | repair bounded global/tenant counters and missing state |
| `app_private.outbox_claim(text,int,timestamptz)` | claim standalone outbox rows with `available_at,account_id,id` locks |
| `app_private.outbox_heartbeat(uuid,uuid,text,bigint,timestamptz)` | extend a standalone outbox lease |
| `app_private.outbox_ack(uuid,uuid,text,bigint,timestamptz)` | acknowledge current-fence delivery |
| `app_private.outbox_fail(uuid,uuid,text,bigint,text,timestamptz)` | retry or terminally fail with redacted error |
| `app_private.outbox_reap(int,timestamptz)` | recover expired standalone outbox leases by `account_id,id` |

The functions validate fixed input types, account/job equality, status and fencing predicates, policy-reduced limits, bounded batch sizes, safe reason/metadata allowlists, and active state rows. `queue_global_state`, `queue_tenant_state`, `job`, and `outbox_event` use `FORCE ROW LEVEL SECURITY`: the singleton has `TO queue_control USING (id='global') WITH CHECK (id='global')`, and the cross-tenant queue rows have `TO queue_control USING (true) WITH CHECK (true)` only because `queue_control` is `NOLOGIN` and reachable solely as the definer owner. Generic `api_rls` policies remain `app.tenant`-scoped. Exact grants expose only queue counters/state and job/outbox operational columns; specifications, scopes, credentials, evidence, reports, billing, membership, and every other business table are unavailable. Cross-account scheduling is an intentional capability of bounded worker functions only. The connector cannot issue `SELECT`, `INSERT`, `UPDATE`, or `DELETE`, has no enqueue/admin function grant, and no API/admin/customer session can call arbitrary SQL. Tenant enqueue uses `packages/db/src/queue.ts`; admin cancel/requeue/account-reaper uses separate JIT-gated `packages/db/src/admin-queue.ts` functions through `admin_queue_connector`. The application uses only typed postgres.js wrappers, never an unsafe SQL surface.

Every job/counter mutation uses one transaction and the same lock order: lock singleton `queue_global_state` with `FOR UPDATE`, then the tenant row, then the job row. Claim uses `FOR UPDATE SKIP LOCKED` and its fairness/job order. Completion, heartbeat, failure, cancellation, and requeue lock the identified tenant and job deterministically. Reaper and reconciler batches lock tenants `ORDER BY account_id FOR UPDATE SKIP LOCKED`, then jobs `ORDER BY id FOR UPDATE SKIP LOCKED`; all counter changes happen in that transaction. A stale fencing token updates zero rows and never decrements a counter. Standalone outbox delivery uses only `available_at,account_id,id` or `account_id,id` locks and never touches global/job rows. This uniform order prevents cross-tenant deadlocks without advisory locks or ambiguous `SERIALIZABLE` retries.

### Admin control plane

The admin app has its own origin, API base path, CSRF protection, cookies, and `staff_identity`, `staff_mfa_factor`, `staff_session`, `staff_role_assignment`, `support_access_grant`, `support_access_approval`, and `admin_audit_event` tables. Staff identity is not a customer membership and customer OAuth cannot log into it. Staff bootstrap is an out-of-band CLI/migration-owner operation keyed by immutable Google Workspace subject; a domain alone is insufficient. Separate Google OIDC, local WebAuthn MFA, hashed one-time recovery, and dual-approved MFA reset are required. `admin_audit_event` is an append-only per-account hash chain with a separate `account_id IS NULL` system/bootstrap chain, nullable `prev_event_hash` for the first event, and explicit composite `(account_id,grant_id)`/`(account_id,approval_id)` FKs plus staff/session FKs; accountless events cannot reference tenant grants or approvals. Payloads are redacted and security mutations fail closed.

Tenant support uses a just-in-time `support_access_grant` with `staff_identity_id`, `account_id`, closed capability enum, reason, ticket reference, requested/approved timestamps, expiry, and separate `support_access_approval` rows. Grants are denied by default, tenant-scoped, short-lived, and audited. Break-glass capabilities require two distinct approvers and a bounded TTL. Admin queue operations call the same policy engine and typed queue-control functions; they may inspect metadata/status/reasons, cancel or requeue within policy, and trigger `/admin/accounts/:accountId/reaper/run` only with an account-bound support grant capability and bounded batch; they cannot execute arbitrary jobs, alter scope, read secrets/raw evidence, or bypass billing webhooks. Billing is read-only.

## Data flows

### Login, invite, and account switch

1. Google callback resolves/creates the global `user` through the narrow bootstrap function.
2. If no membership exists, the first account and owner membership are created atomically; otherwise the user chooses an active account from existing memberships.
3. An owner/admin creates an invitation. The API stores only a token hash and sends the raw bearer token through the configured delivery boundary; the invitation endpoint never auto-links by email.
4. The authenticated recipient sends `POST /invitations/accept` with the token in a body that is redacted before access/app logs. The transaction locks the invitation, verifies expiry/status/hash and authenticated `user_id`, inserts membership, marks `accepted_by_user_id`, rotates `session.account_id`, and appends audit events. A replay by the same accepted user returns the prior idempotent result; another user receives generic invalid-invitation.
5. Account switch calls `auth_list_accounts(session_hash)` or `auth_switch_account(current_hash,target_account_id,new_hash,expiry)`, validates membership, and rotates the session, invalidating the previous active-account claim.

### Assessment dispatch

The existing assessment state transition and policy decision create a job and an outbox event in one account-scoped transaction. The worker claims it with `SKIP LOCKED` and a fencing token, obtains a policy-reduced signed job specification, and dispatches to the isolated runner. Runner completion is accepted only when job ID, account ID, and fencing token match. Findings, reports, credits, and notifications remain account-scoped.

### Admin operation

The admin UI authenticates staff separately, requests a capability grant with reason and ticket, and requires approval. The API evaluates the grant, staff MFA freshness, tenant policy, and operation-specific policy before a transaction. Every read/write records staff actor, account, capability, ticket, reason, outcome, and grant ID; raw evidence and secrets are never included.

## Error and recovery behavior

| Condition | Contract result |
| --- | --- |
| Invitation token missing, expired, reused, revoked, hash mismatch, or presented by another user | Generic `invalid_invitation`; no existence oracle; no membership change |
| Same `accepted_by_user_id` replays a successful acceptance | Idempotent prior result; no duplicate membership or audit side effect |
| Invitation body contains a bearer token | Body is redacted before access/app logs, traces, metrics, and audit |
| Account switch without active membership | `403` and old session remains valid for its current account |
| Stale session after switch/revocation | `401`; require fresh login; no tenant fallback |
| Duplicate membership/invitation acceptance | Idempotent result for the same operation, otherwise `409`; audit records the decision |
| Queue claim loses lease/fencing token | Write affects zero rows; stale worker is stopped and reaped |
| Worker crash or missed notification | `running` lease reaps to `stale_recovered` with backoff; polling recovers the job; `NOTIFY` loss cannot lose work |
| Retry budget exhausted | Terminal `failed` with redacted reason, audit event, and no automatic scope expansion |
| Tenant/global limit reached | Job remains queued with `available_at` and fair scheduling; no busy spin |
| Admin grant absent/expired/not approved | `403`; no fallback capability |
| Break-glass missing second approver | `403`; no partial activation |
| Admin requests secret/raw evidence/arbitrary SQL/impersonation | `403`, audit security event, no query or artifact access |

## Security invariants

1. All business queries run under a non-owner, non-`BYPASSRLS` role with `app.tenant=account_id`; membership itself is the authorization input, not an ID in a URL. During expand, membership identity references use immutable `user.id` FKs plus `account_id`; composite tenant FKs are reserved for session/attestation and cutover paths so the legacy unique `user.account_id` can remain without blocking one user joining multiple accounts.
2. The existing `user` table is the sole customer identity authority. Narrow functions `auth_list_accounts(session_hash)` and `auth_switch_account(current_hash,target_account_id,new_hash,expiry)` provide safe account enumeration/switch and cannot perform arbitrary search, email linking, or cross-account joins.
3. Session cookies are separate for customer and admin origins. Active account is server-side, rotated on login/switch/role-sensitive change, and revocable.
4. Invitation tokens are 256-bit random bearer values, single-use, expiry-bound, hash-only at rest, accepted only in a redacted POST body, and never placed in URLs/logs/audit.
5. Queue claims, heartbeat, completion, cancellation, and reaping require the current fencing token. Every mutation is idempotent and audited.
6. Policy engine remains final authority for target, scope, entitlement, action, rate, duration, concurrency, and admin queue operation. Admin does not become a policy bypass.
7. Queue metadata may be visible to authorized staff under a grant; credentials, secret payloads, raw evidence, runner authorizations, and private keys never are.
8. Stripe webhooks remain the only entitlement/billing state change. Admin may read billing status and event processing results but cannot grant credits or plans.
9. No Redis, Kafka, arbitrary SQL, customer impersonation, SSO, SCIM, or inbound private-agent connection is introduced.

## Testing and proof

Tests are TDD and must run after T021 with the membership slice before T022. Required proof includes:

* two users in one account with each role's allow/deny matrix;
* one user with two accounts, `auth_list_accounts`, explicit `auth_switch_account`, session rotation, and old-session revocation;
* invitation token hash/expiry/single-use, same-user idempotent replay, other-user generic rejection, body redaction, and email non-linking;
* RLS isolation for membership, invitation, queue, outbox, and admin grant rows, including missing tenant context;
* queue-boundary isolation proves `queue_connector` has only `EXECUTE` on fixed-signature functions, zero table grants, no unsafe SQL, no business-data/payload access, and no owner/BYPASSRLS path;
* concurrent claims prove global→tenant→job row locks and tenant/job `SKIP LOCKED` prevent duplicate claim; `queued` and `stale_recovered` are eligible; fencing blocks stale completion and never resets;
* heartbeat, completion, failure, cancellation, retry/backoff, `running`→`stale_recovered` reaper, and reconciliation all use global→tenant→job ordering with deterministic batch `account_id`/`id` locks, both counter decrements/repairs, timeout cleanup, exact queue tenant fairness, and tenant/global limits; standalone outbox processing uses deterministic `available_at,account_id,id`/`account_id,id` locks without global/job access, expired-processing recovery, max-attempt terminal failure/alert/audit, and idempotency;
* admin OIDC, WebAuthn MFA, hashed recovery, dual-approved MFA reset, separate cookie/origin, JIT reason/ticket/TTL/approval, dual break-glass, no impersonation, no owner/BYPASSRLS/arbitrary SQL, no secrets/raw evidence, read-only billing, and policy-aware queue operations;
* migration backfill and cutover tests prove legacy one-user accounts receive one owner membership and no user gains another account.

## Migration and cutover

Migration is expand-contract and reversible until the enforcement switch. The migration number is not hardcoded here: after T021, generate the next applicable Drizzle migration and verify the journal/current highest migration before applying it.

1. Add `account_membership(account_id,user_id)`, invitation, singleton `queue_global_state`, `queue_tenant_state`, outbox, and staff/support tables; create `queue_control`/`queue_connector`, fixed-signature definer functions, RLS/column grants for queue operational state only, and `packages/db/src/queue-bootstrap.ts`; preserve existing `user.account_id` and its unique constraint during the expand phase.
2. Backfill one `account_membership(owner)` per existing `user.account_id` using immutable `(provider, provider_subject)`. Rows without a valid user are quarantined for explicit support resolution, never matched by email. Multiple existing owners remain owners.
3. Add nullable `session.account_id` and backfill it from the legacy account; add composite membership FKs for attestation/session where applicable, while keeping membership identity references as immutable `user.id` FKs plus explicit tenant `account_id` during expand. Backfill singleton/global and every-active-account tenant queue state, queue keys, and `fencing_token=0`; create partial active indexes concurrently only after duplicate jobs are resolved by an audited decision. Verify role attributes, zero connector table grants, function `search_path`, and queue-control isolation before enabling the connector.
4. Deploy dual-read authorization (legacy `user.account_id` plus membership) and narrow functions: update OAuth completion, add `auth_list_accounts`, add `auth_switch_account`, and keep all functions fixed-search-path/`auth_bootstrap`-only. Verify RLS isolation and queue recovery in staging with `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:isolation --maxWorkers=1 -- multiuser-rls && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_multiuser_test bun run test:integration --maxWorkers=1 -- queue-recovery`.
5. Switch reads/mutations to membership and `session.account_id`; rotate sessions at first request and invalidate legacy tenant selectors. Only after observed cutover remove `user.account_id` and its unique constraint in a later generated migration.
6. Enable admin origin/MFA and JIT grants only after out-of-band staff bootstrap, WebAuthn factors, and approval records exist. Remove legacy owner-only paths after retention and review.

Rollback before step 5 disables new invitation/admin routes and reverts reads to the legacy path while preserving additive rows. After step 5, rollback is a forward migration: revoke new sessions, preserve membership/audit history, and correct access through explicit membership changes; never delete audit or queue history.

## Non-goals

This phase does not add SSO, SCIM, customer webhooks, arbitrary SQL, impersonation, owner/BYPASSRLS runtime access, admin access to secrets/raw evidence, billing writes, a new queue broker, or active assessment behavior. The Foundation Phase 2 historical non-goal remains valid; this document is a future extension to execute after T021.

## Acceptance criteria

* The existing global Google `user` can access an account only through an active membership; email equality never creates a link and multiple active owners are supported while last-owner removal/demotion is transactionally denied.
* Roles enforce owner/admin/operator/viewer/billing capabilities in API and RLS, with explicit invite acceptance and auditable changes.
* Account switch rotates and revokes sessions; every customer request has one server-selected active account.
* PostgreSQL is the queue source of truth. Concurrent workers claim distinct `queued`/`stale_recovered` jobs after global→tenant→job locking with singleton `queue_global_state` and exact `queue_tenant_state` fairness locking; fencing never resets, heartbeat, retry/backoff, reaper, and tenant/global limits are proven.
* Queue control is least privilege: `queue_control` is `NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`, `queue_connector` has only `EXECUTE` on fixed-signature worker queue/outbox functions and zero table grants, tenant enqueue is policy-gated through `packages/db/src/queue.ts`, admin queue functions are separate JIT-gated calls, queue operational access excludes business payloads, and all job/counter completion/cancel/fail/reaper/reconcile paths use deterministic global→tenant→job locks with stale-fence no-op while standalone outbox paths never touch global/job.
* State changes and outbox rows commit atomically; missed `NOTIFY` cannot lose work, duplicate delivery is harmless, and exhausted outbox retries become audited terminal failures with alerting.
* Admin uses separate `staff_identity`/`staff_session`/`staff_mfa_factor`/`staff_role_assignment`/`support_access_grant`/`support_access_approval` tables, origin/cookies, separate OIDC/WebAuthn MFA, hashed recovery, and dual-approved break-glass; all are TTL-bound and audited.
* Admin cannot impersonate, bypass RLS, run arbitrary SQL, read secrets/raw evidence, or mutate billing/entitlement.
* Existing FR-001–FR-021, SC-001–SC-010, and Constitution I–VI remain satisfied; new traceability is recorded in the Phase 2A tasks and contracts.
