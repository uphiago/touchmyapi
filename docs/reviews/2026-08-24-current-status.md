# Current implementation status

Date: 2026-08-24

## Green and usable now

- Public entry: `touchmyapi.com` serves the marketing landing; `www` canonicalizes
  to it; `app.touchmyapi.com` has a separate private sign-in entry.
- Local path: `bun run dev:local` starts PostgreSQL, migrations, customer API/web,
  worker, admin API/web, MinIO, and attached logs. `bun run local:smoke` exercises
  the multi-user queue and report fixture without contacting targets.
- Customer boundary: GitHub provider-neutral OAuth flow, server-selected account,
  membership roles, account switching, invitations, RLS, policy-gated assessment
  drafts, durable PostgreSQL queue/outbox primitives, notifications, and local
  private report delivery.
- Delivery: production Compose, SHA-tagged GHCR images, verified SSH to OVH,
  migration-before-cutover, Caddy validation, rollback metadata, and public smoke
  are running through the protected GitHub Actions workflow.
- Verification: unit, contract, integration/isolation CI, typecheck, lint,
  formatting, customer/admin builds, local smoke, and local E2E are green. The
  latest unit count is 337 passing tests.

## Still pending before calling the platform production-complete

1. **Production customer login** — create the GitHub OAuth App with the exact
   callback `https://api.touchmyapi.com/api/v1/auth/github/callback`, provision
   host-only client credentials, and change `AUTH_PROVIDER` from `disabled` to
   `github`. Until then, the UI correctly reports that sign-in is unavailable.
2. **Queue acceptance gate (T087)** — run the recovery/concurrency acceptance
   suites against fresh isolated PostgreSQL databases and record the integration
   review. The local fixture proves the flow but does not satisfy production
   target execution acceptance.
3. **Persistent admin control plane (T088–T094/T107)** — staff contracts and RLS,
   separate OIDC, WebAuthn MFA/recovery, durable JIT grants/break-glass,
   account-scoped queue operations, and the production admin E2E/runbook. The
   current admin console is intentionally development-only.
4. **Production passive execution and reports (T106)** — reviewed rootless
   Podman/runsc runner, signed job capability, egress and DNS-rebinding controls,
   credential channel cleanup, enabled private object storage, and a post-deploy
   execution smoke. Production currently accepts/queues intent but must not claim
   target contact.
5. **Billing/entitlements (T038–T046)** — Stripe Checkout/webhook verification,
   dedupe/reconciliation, credit ledger, and server-derived plan transitions.
6. **Lifecycle and operations (T063–T069)** — retention sweeper, account deletion
   and data elimination, audit-chain acceptance, metrics/alerts, per-account AI
   disable, and the final quickstart drift pass.
7. **Private agent (T055–T062)** — outbound agent gateway, signed expiring specs,
   local runner, revocation, and onboarding UI for internal targets.
8. **Cloudflare R2** — keep it disabled until a bucket/policy is chosen. Any R2
   token previously pasted into chat must be revoked and replaced; no credential
   is stored in the repository or deployment files.

The authoritative task checkboxes remain in
[`specs/001-touchmyapi-platform/tasks.md`](../../specs/001-touchmyapi-platform/tasks.md).
The unchecked items above are deliberate product/security gates, not missing UI
polish.
