# Feature Specification: TouchMyAPI Platform

**Feature Branch**: `001-touchmyapi-platform`

**Created**: 2026-08-17

**Status**: Draft

**Input**: User description: "Plataforma de assessments de segurança autorizados com login Google, planos, fila, runner isolado, agente privado, IA e relatórios."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Authenticated Assessment Pipeline (Priority: P1)

An individual user signs in with Google and creates an assessment against an authorized external target through a guided modal: choose target category, provide URL/domain/API spec or private-agent connection, delimit scope/inclusions/exclusions/window/contacts/credentials, review the playbook with estimated credit consumption and impact limits, and supply a versioned authorization declaration. For any active external run the system requests/confirms HTTP verification on the target domain before the job is queued. The user follows the assessment through a list view (draft → awaiting_verification → queued → running → analyzing → completed/failed/cancelled), sees findings permitted by their plan, and receives an in-product notification on completion. Credentials are never shown again once saved; the UI only indicates existence and allows replace/delete.

**Why this priority**: This is the core product loop. Without it nothing else (billing, reports, private agent) delivers value, and the security posture described in the constitution depends on this flow.

**Independent Test**: Can be fully tested by signing in with a test Google account, creating a passive public-posture assessment with no verification, watching it complete, and confirming the dashboard shows the aggregated posture with no active testing.

**Acceptance Scenarios**:

1. **Given** a fresh authenticated user, **When** they start a new assessment and pick a category, **Then** the modal guides them through target, scope, limits, playbook, credit estimate, authorization declaration, and verification in the required order.
2. **Given** an active external target, **When** the user submits an assessment, **Then** it enters `awaiting_verification` and no active testing starts until HTTP verification succeeds.
3. **Given** a completed assessment, **When** the user views the dashboard, **Then** they see status, scope, summary, plan-permitted findings, timeline, and credits, and receive an in-product notification.
4. **Given** saved external credentials, **When** the user revisits the assessment, **Then** credentials are not returned to screen; UI shows existence only.

---

### User Story 2 - Plans, Billing, and Entitlement (Priority: P1)

The user on the free plan sees passive public-posture results only (DNS, cert/TLS, HTTP headers, apparent technologies, robots.txt, sitemap.xml, minimal public endpoint collection) with no active testing. After completing HTTP verification and an authorization declaration, free-verified users may run a limited introductory assessment whose dashboard shows title, category, and severity only. Paying users (one-off purchase via Pix/card, or Pro subscription via card) unlock evidence, safe reproduction, impact, recommendation, PDF technical, PDF executive, JSON export, scheduled recurring runs, and comparable history. Stripe webhooks - signature-verified and idempotently processed - are the only fact that grants or revokes entitlement. Catalog values (prices, quotas, credit matrix) live server-side.

**Why this priority**: Monetization gates nearly every post-assessment capability, and the financial-integrity rule (webhook-only entitlement changes) is a constitution constraint that must be in place before paid flows are safe.

**Independent Test**: Can be fully tested by confirming free users only ever see permitted (aggregated or masked) results, then completing a payment and verifying a validated Stripe webhook flips entitlement exactly once (no duplicates on redelivery).

**Acceptance Scenarios**:

1. **Given** an unverified free user, **When** they run an assessment, **Then** only passive public-posture analysis is executed and no active testing occurs.
2. **Given** a verified free user, **When** they run an introductory assessment, **Then** the dashboard shows title, category, and severity but evidence, endpoint, reproduction, impact, and remediation stay blocked.
3. **Given** a paying user, **When** a confirmed Stripe webhook event arrives, **Then** entitlement is granted or revoked exactly once, idempotently, even on redelivery.
4. **Given** the browser, **When** a purchase is initiated, **Then** it only starts purchase intent; no price, quota, or entitlement logic lives in the client.

---

### User Story 3 - Reports and Evidence (Priority: P2)

After a completed assessment, the user consults findings in the dashboard and downloads reports permitted by their plan: PDF technical (methodology, scope, limitations, redacted evidence, severity, impact, remediation, findings appendix), PDF executive (risk, priorities, trend, short action plan), and JSON (versioned contract, no secrets) on paid plans. Later runs support comparison across executions. Reports clearly declare untested items, scope limitations, and where a conclusion is inference rather than validated fact. Signed URLs serve files from private storage; no public bucket.

**Why this priority**: Reports are the deliverable the customer pays for, but they depend on completed assessment pipeline and plan gating, so they come after US1/US2.

**Independent Test**: Can be fully tested by completing a paid assessment and confirming PDF technical, PDF executive, and JSON are downloadable only to the owning account with redacted evidence, and that a free account cannot fetch them.

**Acceptance Scenarios**:

1. **Given** a completed paid assessment, **When** the user requests PDF technical, **Then** it contains methodology, scope, limitations, redacted evidence, severity, impact, remediation, and findings appendix.
2. **Given** a JSON export request on a paying plan, **When** served, **Then** it matches the versioned contract and contains no credentials or secrets.
3. **Given** a free (even verified) account, **When** it requests evidence or reproduction detail, **Then** the response is denied and details stay blocked.

---

### User Story 4 - Private Agent for Internal Targets (Priority: P2)

A paying customer installs the private agent inside their environment. The agent holds its own identity (revocable, limited to the environment/account) and opens a client-initiated authenticated connection to the control worker; no inbound connection from the internet into the customer network. Server sends a signed, limited, expiring job specification; the agent executes locally with an isolated runner, returns permitted artifacts, and never sends secrets. Onboarding shows unique token, fingerprint, status, last activity, and revocation. Internal credentials never reach the server. The first version offers no interactive host access.

**Why this priority**: Extends the product to internal environments, a distinct market category, but depends on the control-worker dispatch and policy engine from US1/US2.

**Independent Test**: Can be fully tested by installing the agent in a controlled environment, connecting it, dispatching a job for an internal target, and confirming artifacts return without any secret leaving the agent and without any inbound connection.

**Acceptance Scenarios**:

1. **Given** a customer private agent, **When** it connects, **Then** outbound authenticated connection is established, showing unique token, fingerprint, status, last activity, and revocation in onboarding.
2. **Given** a dispatched internal job, **When** the agent receives a signed job spec, **Then** it executes locally within limits and returns permitted artifacts, never uploading internal credentials.
3. **Given** a revoked agent identity, **When** it attempts further jobs, **Then** dispatch is refused and no new jobs are accepted.

---

### User Story 5 - Shared Accounts and Membership (Priority: P1 for multi-user extension)

An account owner invites collaborators to a workspace with an explicit role (`owner`, `admin`, `operator`, `viewer`, or `billing`). The existing global Google `user` can belong to multiple accounts through explicit memberships, but an invitation is accepted only by an authenticated user through an explicit action; email is delivery data and never auto-links an account. The active account is stored in `session.account_id`, and switching accounts rotates the session. Every assessment, credential, job, finding, report, credit, membership, and invitation remains isolated by `account_id`.

**Independent Test**: Two authenticated users share one account and have separate accounts; invitation acceptance, role restrictions, account switching, session rotation, and cross-account RLS tests prove that neither user can read or mutate the other account.

### User Story 6 - Durable Queue and Admin Control Plane (Priority: P1 for multi-user extension)

The control worker claims jobs from PostgreSQL using `FOR UPDATE SKIP LOCKED`, a lease and fencing token. Heartbeats, retry/backoff, timeout, cancellation, reaper recovery, fair scheduling, tenant/global limits, and a transactional outbox make worker restarts and missed notifications safe. Staff use a separate admin app/API/origin, identity, cookies, and mandatory MFA. Tenant access is granted just in time with a reason, ticket, TTL, and approval; break-glass requires two approvers. Admin operations are policy-aware and expose neither secrets nor raw evidence.

**Independent Test**: Concurrent workers claim distinct jobs, stale workers cannot complete after lease loss, reaper/backoff recovers abandoned jobs, outbox delivery survives a missed `NOTIFY`, and admin tests prove separate MFA sessions, TTL-bound capability grants, dual break-glass, no impersonation, no arbitrary SQL, no RLS bypass, read-only billing, and no secret/raw-evidence access.

---

### Edge Cases

- What happens when a verification file is not yet present on the target domain when verification is attempted? (stays in `awaiting_verification`, retries per policy, user sees a clear retry state)
- How does the system handle a job abandoned mid-run (worker crash)? (lease expiry, abandonment recovery, transition to failed/cancelled with reason preserved, never stuck)
- What happens on concurrent dispatch for the same target/account? (second attempt rejected; one active execution per target/account)
- What happens on Stripe webhook redelivery or out-of-order events? (idempotent processing by external event id; no credit duplication)
- What happens when the AI provider is unavailable or disabled per account? (analyzing state must not hard-block; deterministic fallback triage completes the run)
- What happens when a target is external but exposes no HTTP server (e.g., API host at bare TCP)? (active execution is unavailable at launch; accepting TXT or another proof later requires a constitution amendment and migration plan)
- What happens on account deletion with active agents/schedules/webhooks? (cancel schedules, revoke agents/tokens, request session revocation, start data elimination per retention)
- What happens when an invitation is expired, reused, revoked, or presented by another authenticated user? (POST body is redacted before access/app logs; return one generic invalid-invitation response; same `accepted_by_user_id` replay is idempotent)
- What happens when a Google user belongs to multiple accounts? (require an active server-side account selection; switching validates membership and rotates/revokes the prior session)
- What happens when a worker loses a lease or a `LISTEN/NOTIFY` wake-up is missed? (fencing rejects stale writes; lease reaper and polling recover from PostgreSQL)
- What happens when a tenant reaches its queue limit or a noisy tenant fills global capacity? (leave jobs queued with fair scheduling and no busy-spin; never exceed tenant/global policy limits)
- What happens when an admin grant expires or lacks MFA/approval? (deny the operation; break-glass requires two distinct approvals and a bounded TTL)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST authenticate users exclusively via Google OAuth at launch (Authorization Code + PKCE, state, nonce, exact redirect URIs); GitHub and X remain modeled but disabled.
- **FR-002**: System MUST store identity as immutable `provider + provider_subject`; accounts are linked only explicitly, never by automatic email matching.
- **FR-003**: System MUST scope all data by `account_id` and enforce Row-Level Security in PostgreSQL with non-owner, non-RLS-bypass runtime roles (default deny).
- **FR-004**: System MUST accept only authorized assessments requiring target, scope, exclusions, playbook, limits, HTTP verification (for active external runs), and a versioned authorization attestation.
- **FR-005**: System MUST gate results and capabilities by plan: free unverified (passive aggregate only), free verified (masked summary, blocked details), paid (evidence, reproduction, impact, recommendation, PDFs, JSON, scheduling, history).
- **FR-006**: System MUST process all payment/entitlement changes through signature-verified, idempotent Stripe webhooks only; the browser only initiates purchase intent.
- **FR-007**: System MUST dispatch assessments through a durable queue (PostgreSQL-backed with lease, retry/backoff, dedup, cancel, timeout, abandoned-job recovery) with one active execution per target/account.
- **FR-008**: System MUST transition assessments through draft → awaiting_verification → queued → running → analyzing → completed/failed/cancelled, with backend-validated idempotent transitions and a cancellation signal plus mandatory cleanup for active runners.
- **FR-009**: System MUST execute every job in an isolated ephemeral sandbox with signed TTL'd job, minimal capabilities, closed action list, digest-pinned image, non-root user, temporary filesystem, limited CPU/memory/duration, controlled egress.
- **FR-010**: System MUST deliver external credentials only through short-lived secret channels to the runner per job and remove them on termination; they never reach persistent vars, logs, reports, or models.
- **FR-011**: System MUST return only plan-permitted evidence with redaction, hashes, and provenance artifact manifests.
- **FR-012**: System MUST keep all evidence/reports in private object storage with temporary authorized URLs; never a public bucket.
- **FR-013**: System MUST generate PDF technical, PDF executive, and versioned JSON reports per plan permissions, explicitly declaring untested items, scope limits, and inference-vs-fact.
- **FR-014**: System MUST use the policy engine as final authority, blocking out-of-scope targets, local/metadata/private networks, forbidden redirects, disallowed ports/commands, excessive rate/duration/concurrency/credits; browser/model/runner cannot escalate.
- **FR-015**: System MUST treat AI as non-executor: DeepSeek plans/triages (structured, sanitized output reduced or rejected by the policy engine), Codex drafts from validated redacted findings only; target-derived content can never alter tools, scope, memory, secrets, or policy.
- **FR-016**: System MUST log external AI usage per assessment and support disabling external AI per account at a later phase.
- **FR-017**: System MUST support a client-installed private agent connecting outbound with its own revocable identity, receiving signed expiring job specs, executing locally in isolation, returning permitted artifacts, and never storing internal credentials server-side.
- **FR-018**: System MUST store a chained append-only audit trail across request, authorization, verification, policy decision, dispatch, runner, artifacts, analysis, publication, download, billing.
- **FR-019**: System MUST apply retention policies: raw evidence 30d post-completion (scheduled deletion), findings/reports 365d paid plans, execution logs 30d (redacted/limited), audit 365d, external credentials until job end unless explicitly retained, internal credentials never stored.
- **FR-020**: System MUST expose a plan-permitted dashboard (status, scope, summary, findings, timeline, credits) and in-product notifications; integrations (Slack/Teams/webhooks/email/push) remain non-functional placeholders at launch.
- **FR-021**: System MUST run playbooks from versioned contracts (version, preconditions, target category, allowed actions, request limits, max duration, stop signals, expected evidence, possible severity) following scope → discovery → hypothesis → focused validation → negative control → evidence → report.
- **FR-022**: System MUST treat `account` as the tenant/workspace and authorize business data through an `account_membership` with exactly `owner`, `admin`, `operator`, `viewer`, or `billing` roles; multiple active owners are allowed, but the last active owner MUST NOT be removed or demoted transactionally; invitations MUST be explicit, single-use, expiry-bound, token-hash based, and email MUST never auto-link a global user.
- **FR-023**: System MUST use the existing `user` table as the single global Google identity authority, keep `account_membership(account_id,user_id)` as tenant authorization, support one user in multiple accounts, bind the active account to `session.account_id`, and rotate/revoke the session on account switch, membership removal, or security-sensitive role change.
- **FR-024**: System MUST use PostgreSQL as queue source of truth with `FOR UPDATE SKIP LOCKED`; claims accept `queued` or `stale_recovered`, set `running`, increment a monotonic fencing token, and enforce heartbeat, bounded retry/backoff, timeout, cancellation, reaper recovery, exact tenant fairness through `queue_tenant_state` for every active account, partial unique active target/account protection across `queued`/`stale_recovered`/`running`, and tenant/global limits; account creation upserts tenant state transactionally, reconciliation repairs missing/drifted state, and missing state fails closed without dropping or stranding jobs; Redis and Kafka are not required.
- **FR-025**: System MUST commit transactional outbox events with state changes, claim outbox rows with short leases/fencing/heartbeat, recover expired processing rows, and process at-least-once idempotently; `LISTEN/NOTIFY` MAY wake a poller but MUST NOT be the delivery guarantee.
- **FR-026**: System MUST isolate admin in a separate app/API/origin with separate `staff_identity`, `staff_mfa_factor`, `staff_session`, `staff_role_assignment`, `support_access_grant`, `support_access_approval`, and cookies, mandatory separate Google OIDC plus WebAuthn MFA, out-of-band staff bootstrap, policy-aware queue operations, and just-in-time support grants recording reason, ticket, TTL, and approval; break-glass requires dual approval.
- **FR-027**: Admin MUST NOT impersonate customers, use owner or `BYPASSRLS` runtime access, run arbitrary SQL, read secrets/raw evidence, or mutate billing/entitlements; billing views are read-only and every admin action is append-only audited.

### Key Entities

- **Account**: tenant/workspace that governs ownership, isolation, billing, and all account-scoped business data via `account_id`.
- **User**: the existing immutable global Google identity (`provider + provider_subject`) that may have memberships in multiple accounts; email is display/delivery data only.
- **AccountMembership**: explicit `account_id` + `user_id` link with role `owner`/`admin`/`operator`/`viewer`/`billing`, status, and audit timestamps.
- **AccountInvitation**: single-use expiry-bound bearer token hash, account, delivery email, proposed role, inviter user, accepted user, and acceptance audit; raw token never persists or appears in URL/logs.
- **Assessment**: a unit of work with target category, normalized target, scope, exclusions, window, contacts, playbook version, limits, authorization attestation, and state machine.
- **AuthorizationAttestation**: versioned declaration storing user, account, target, date, terms version, and submitted scope.
- **Target**: normalized external target (web, API/HTTP/GraphQL/gRPC, external surface, GenAI) or internal environment via private agent.
- **Playbook**: versioned contract of allowed actions and limits per target category.
- **Job**: signed dispatch unit for the runner with TTL, capabilities, action list, and artifact manifest.
- **RunnerExecution**: isolated sandbox execution with credentials channel, limits, output manifest, hashes, provenance.
- **Credential** (external): encrypted at rest server-side, delivered per-job only; internal credentials never stored.
- **PolicyDecision**: record of policy engine authorization for actions/blocks.
- **Finding**: validated result with severity, evidence, impact, remediation, permitted visibility by plan.
- **Report**: PDF technical, PDF executive, JSON export - versioned, sanitized, plan-gated.
- **CreditEntry**: catalog-driven consumption per target type/size, never per number of findings.
- **BillingEvent**: Stripe webhook record with external event id, minimal payload, validated signature, event version, processing result - source of truth for entitlement.
- **Agent** (private): client-installed identity with unique token, fingerprint, status, last activity, revocation; outbound connection.
- **AuditEvent**: append-only chained record across the execution lifecycle.
- **Notification**: in-product notification for assessment completion.
- **OutboxEvent**: transactional account-scoped event committed with a state change; unique key, retry metadata, and idempotent delivery status.
- **QueueTenantState**: one fairness/capacity row per active account with `last_dispatched_at`, `running_count`, and `concurrency_limit`; account creation upsert and reconciler maintain it.
- **StaffIdentity**: staff-only immutable Google Workspace subject with separate staff OIDC, WebAuthn MFA, recovery, and session; never a customer membership.
- **SupportAccessGrant**: short-lived, reasoned and ticketed per-account admin capability with `support_access_approval` records and expiry; break-glass needs two approvers.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user completes assessment creation, execution, and in-product notification without exposure to queues, workers, models, containers, or credentials (verified via user-walkthrough acceptance).
- **SC-002**: An authenticated user can never access another account's data, PDFs, credits, credentials, or jobs (isolation tests pass; default-deny RLS).
- **SC-003**: No active external test starts without valid HTTP verification, explicit scope, and a versioned authorization attestation (100% of active runs).
- **SC-004**: Every job completes, fails, or cancels with a preserved reason/audit trail; no job is left stuck across worker restarts.
- **SC-005**: Stripe entitlement changes happen only via validated, idempotent webhooks; redelivery never duplicates credits.
- **SC-006**: Runner never executes an action outside the signed job and removes all temporary material on termination.
- **SC-007**: Internal credentials never reach the server; external credentials never reach the frontend, logs, reports, or models.
- **SC-008**: AI has no direct access to tools, credentials, arbitrary network, or raw private data; external AI use is logged per assessment and disable-able per account.
- **SC-009**: Reports and JSON respect plan permissions; free accounts never obtain blocked details, evidence, or reproduction steps.
- **SC-010**: Account deletion cancels schedules, revokes agents/tokens/sessions, and initiates data elimination per retention and legal obligations.
- **SC-011**: The existing global `user` can access an account only through an active `account_membership(account_id,user_id)`; two-account RLS tests prove no cross-account read, write, reference, or inference for membership, invitation, assessment, job, billing, evidence, or report data.
- **SC-012**: Invitation acceptance is explicit, token-hash based, single-use, expiry-bound, and never links by email; role capability tests pass for all five roles.
- **SC-013**: Account switching always rotates/revokes sessions and every account-scoped request uses one server-selected active account.
- **SC-014**: Concurrent workers, `queued`/`stale_recovered` claims, stale leases, worker crashes, retry exhaustion, cancellation, exact `queue_tenant_state` fairness, tenant/global limits, missing/drifted state reconciliation, fail-closed queue behavior, and missed notifications leave no lost, stranded, or doubly completed job; fencing and reaper tests pass.
- **SC-015**: State changes and outbox rows are atomic and outbox re-delivery is idempotent; `NOTIFY` loss does not lose work.
- **SC-016**: Admin requires separate staff MFA and a valid TTL-bound capability grant; dual break-glass, no impersonation/RLS bypass/arbitrary SQL, no secret/raw-evidence access, policy-aware queue operations, and read-only billing tests pass.

## Assumptions

- Market launch is Brazil, BRL currency; Stripe Checkout hosts Pix/card one-off and card subscription for Pro.
- Foundation Phase 2 historically models one individual account and does not implement organizations, invites, roles, SSO, or SCIM. The approved Phase 2A extension adds account/workspace membership and admin controls after T021; SSO and SCIM remain out of scope.
- Redis, Kafka, and Kubernetes are not launch prerequisites; PostgreSQL is the durable queue and source of truth initially.
- The runner abstraction sits behind a `SandboxProvider` so persistent/managed sandboxes can replace ephemeral containers without changing product domain.
- One active execution per target/account plus conservative global limits; minimum metrics: queue depth, job age, failure rate per playbook, duration, cancellations, credit usage, policy blocks, webhook failures, cross-account-access attempts; internal alerts are not customer integrations.
- Active external assessments at launch are limited to HTTP-serving targets that can complete HTTP-file verification; other proof methods require a constitution amendment.
- Playbooks and contract schemas are defined before the policy engine; no scanner is built before the policy engine.
- Edge cases around AI-provider unavailability and plan gating require deterministic fallbacks so analysis never hard-blocks.
