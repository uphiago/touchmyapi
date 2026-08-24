# Total product and delivery review

Date: 2026-08-24

## User-facing result

- `https://touchmyapi.com` is the credential-free public landing page.
- `www.touchmyapi.com` canonicalizes to the apex.
- `https://app.touchmyapi.com` is the authenticated customer console.
- API and staff surfaces remain separate hosts; a customer cookie is not accepted
  by the staff API.
- The landing clearly reports whether GitHub OAuth is configured. It does not
  show a fake login action when the external OAuth App is missing.
- Local development renders the same landing-to-console flow with explicit
  credential-free fixtures and never contacts a target.

## Implemented in this review

- Tracked Caddy edge source, validation, previous-config backup and safe
  force-recreate before application cutover.
- Apex/www/app public-host routing and browser tests.
- Runnable local E2E journey; the obsolete pending E2E placeholder and
  `passWithNoTests` escape hatch were removed.
- Honest queued-state copy when the production isolated runner is disabled.
- Exact tenant/account/assessment report object-key validation.
- Scope redaction for report metadata.
- Cleanup of prepared object-storage files when publication is rejected or a
  report write is partial.
- Production storage no longer attempts bucket creation; local storage may do so
  explicitly.
- Automatic application rollback on a failed release, while database migrations
  remain forward-only.
- Documentation and task/spec status were synchronized with the current slice.

## Verification evidence

- Unit: 34 files, 336 tests passed.
- Contract: 15 files, 63 tests passed.
- Local smoke: API, admin API, customer web, admin web, worker readiness,
  PostgreSQL draft → queue → completed delivery, three private reports, and the
  bounded admin approval flow passed.
- Local E2E: 1 test passed.
- Typecheck, ESLint, Prettier, workspace verification, API/admin/web/worker
  builds and shell syntax checks passed.
- Integration and database-isolation projects are opt-in by design. They must
  run against separate clean `_test` databases; a shared ad-hoc database is not
  treated as acceptance evidence. The README contains the isolated setup.

## Explicitly open

- A GitHub OAuth App must be created and its host-only credentials provisioned
  before production sign-in becomes available.
- Production private object storage/R2 remains disabled until bucket, endpoint,
  access policy and credentials are provisioned. Any credentials pasted into a
  chat or shell history must be rotated; this review stores none.
- The isolated production runner, active HTTP verification, Stripe webhook
  entitlements, persistent staff OIDC/WebAuthn/JIT, account deletion workflow,
  and private agent remain later task milestones. Production must not claim that
  a queued assessment contacted a target until the runner milestone is accepted.
