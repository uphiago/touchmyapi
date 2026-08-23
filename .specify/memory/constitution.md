<!--
Sync Impact Report
- Version change: 1.1.0 → 1.1.1
- Modified principles: none; this patch clarifies mandatory queue concurrency and recovery constraints without weakening Principles I–VI
- Added constraints: explicit singleton global queue state upsert/backfill/reconciliation and exact global→tenant→job counter/lock behavior
- Removed principles: none
- Templates requiring updates: none; Phase 2A requirements are recorded in the product contracts and plan
- Migration reference: docs/superpowers/specs/2026-08-22-multiuser-queue-admin-design.md §Migration and cutover; docs/superpowers/plans/2026-08-22-multiuser-queue-admin.md
- Justification: close the queue design gap by making singleton capacity initialization, lock ordering, counter repair, and terminal outbox behavior unambiguous while preserving default-deny RLS and the separately isolated administrative plane
-->

# TouchMyAPI Constitution

## Core Principles

### I. Authorized Assessments Only

Every execution MUST be attributable to a user, an account, a target, an explicit scope, and an executing policy. No test starts without a valid authorization attestation, and for any active external test, a completed HTTP verification on the target domain. Silent scanning, unauthenticated exploitation, and execution outside the declared scope are violations. The platform is a security-assessment product, not an unrestricted scanner, remote shell, or "try-everything agent".

### II. Policy Engine Is the Final Authority

The policy engine, not the browser, the AI model, or the runner, is the authority for what may execute. It blocks targets outside scope, local/metadata/private networks for external tests, forbidden redirect targets, disallowed ports and commands, excessive rate, duration, concurrency, and credit usage. The browser and model MUST NOT be able to escalate these limits. Every mutation on the API validates schema, ownership, state, and entitlement. IDs never grant access.

### III. Default-Deny Data Isolation

All tenant and business data is scoped by `account_id` (the account/workspace boundary) and enforced by Row-Level Security in PostgreSQL with runtime roles that are neither owner nor RLS-bypassers. Global login identities (`provider + provider_subject`) may exist outside an account only behind narrow, fixed-purpose bootstrap or administrative functions; they are never a substitute for tenant scope and are never auto-linked by email. Memberships, invitations, account settings, assessments, jobs, billing, evidence, and every other business row are account-scoped and RLS-protected. Cross-account access must be impossible by design and proven by explicit isolation tests. The frontend NEVER receives secret keys, entitlements, OAuth secrets, private Stripe keys, target credentials, or runner authorizations. Anything prefixed `VITE_` is public by definition.

### IV. Least Privilege for Runners and Credentials

Run every job in an isolated ephemeral sandbox with a signed, TTL'd job definition, minimum capabilities, and a closed list of actions. Image pinned by digest, non-root user, temporary filesystem, limited CPU/memory/duration, controlled egress. No Docker socket, no direct database access, no generic shell exposed to user or model. Credentials are delivered through short-lived secret channels and removed on termination; they never reach persistent variables, logs, reports, or models. Internal credentials live only in the client's private agent and never in the platform.

### V. AI as Non-Executor

AI models plan and triage or draft reports; they never execute network, shell, or attack tooling directly. Model output is treated as untrusted data that the policy engine reduces or rejects. Target-derived content (pages, RAG, model responses) can never alter tools, scope, memory, secret access, or policy. Raw private data is never sent to external AI providers; external AI use is logged per assessment and must be capable of being disabled per account.

### VI. Financial State Changes Only by Verified Webhook

Stripe is the only source of truth for payment, credits, and entitlement changes. The browser only initiates purchase intent; the API creates the internal order and associates account, product, price, currency, and reference. The Stripe webhook, signature-verified and idempotently processed, is the only fact that grants or revokes access. Re-deliveries never duplicate credits. Catalog values (prices, quotas, credit matrix) live on the server, never as frontend constants.

## Mandatory Security Constraints

- Sessions are HttpOnly, Secure, SameSite-appropriate, rotated and revocable. OAuth uses Authorization Code with PKCE, `state`, nonce, and exact redirect URIs.
- Active assessments require: normalized target, explicit scope, exclusions, playbook, limits, HTTP verification, and a versioned authorization attestation storing user, account, target, date, terms version, and submitted scope.
- File evidence and reports live in private object storage with temporary per-user authorized URLs; never a public bucket.
- Dangerous payloads, unavailability attacks, exfiltration, persistence, brute force, and invasive exploitation are not part of default execution. Any future extension needs an explicit category, consent, and its own policy.
- Audit trail is append-only at the application level and chained across request, authorization, verification, policy decision, dispatch, runner, artifacts, analysis, publication, download, and billing.
- PostgreSQL is the queue source of truth: claims lock singleton `queue_global_state` with `FOR UPDATE`, then `queue_tenant_state` and jobs with `FOR UPDATE SKIP LOCKED` in global→tenant→job order, use `last_dispatched_at NULLS FIRST, account_id` tenant order and `priority DESC, available_at, created_at, id` job order, a lease plus monotonic fencing token, heartbeat, bounded retry/backoff, reaper recovery, and tenant/global concurrency limits. Transactional outbox rows are committed with state changes and use their own short lease/fencing/heartbeat recovery, bounded `max_attempts`, redacted terminal failure with alert/audit; advisory hash locks and ambiguous `SERIALIZABLE` retries are forbidden. `LISTEN/NOTIFY` may only be a wake-up hint and may never be the delivery guarantee. Redis and Kafka are not required for this boundary.
- The admin control plane is a separate app/API/origin with separate staff identity and cookies, mandatory MFA, no impersonation, no owner role, no `BYPASSRLS`, and no arbitrary SQL. Per-tenant JIT capability grants require a reason, ticket, TTL, and approval; break-glass requires dual approval. Admin access is policy-aware, least-privilege, audited, and exposes neither secrets nor raw evidence. Billing views are read-only.
- Data retention defaults: raw runner evidence 30 days post-completion with scheduled deletion; findings and reports 365 days for paid plans; execution logs 30 days redacted and limited; security/authorization audit 365 days append-only; external credentials until job end unless explicitly stored for future schedule; internal credentials never stored.

## Governance

The constitution supersedes all ad-hoc practice. Amendments require documentation, justification, and a migration plan; constitution version follows semantic versioning (MAJOR for principle removal/redefinition, MINOR for added principles, PATCH for clarifications). This 1.1.1 patch clarifies the singleton queue capacity, exact lock/counter recovery, and terminal outbox invariants introduced by the 1.1.0 multi-user amendment without weakening Principles I–VI. All PRs and reviews must verify compliance with these principles. Every new milestone re-checks acceptance criteria from the product spec: cross-account isolation, verification-before-active-test, no platform-side internal credentials, webhook-only entitlement changes, and AI with no direct tool or credential access. Complexity must be justified; simpler alternatives win unless a recorded reason exists (see Complexity Tracking in plan.md).

Use `.specify/memory/constitution.md` and mirrored runtime guidance in `AGENTS.md` for development guidance.

**Version**: 1.1.1 | **Ratified**: 2026-08-17 | **Last Amended**: 2026-08-22
