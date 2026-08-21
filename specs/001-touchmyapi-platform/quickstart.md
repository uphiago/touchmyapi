# Quickstart: TouchMyAPI Platform

**Phase 1 output** | **Date**: 2026-08-17

Runnable validation guide proving the feature works end-to-end. No full implementation code here - links point to contracts and data model. Used by the implement phase and `/speckit.converge`.

## Prerequisites

- Bun 1.x
- PostgreSQL 16+ (local via `infra/docker/compose.yml`)
- Stripe test keys in `.env` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`)
- Google OAuth client credentials in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
- Podman with rootless support + gVisor `runsc` installed (or `SANDBOX_IMPL=noop` for CI)
- Private object storage (S3-compatible) credentials, or local MinIO in compose

## Setup

```bash
bun install
cp .env.example .env   # fill Google + Stripe test keys
bun run db:up          # start Postgres + MinIO (compose)
bun run db:migrate     # drizzle-kit: schema + RLS policies via pgPolicy/pgRole
bun run db:seed        # playbook catalog + a sandbox account fixture
```

## Validation scenarios (in order)

### 1. Login and isolation smoke test

```bash
bun run dev:web    # Vite client
bun run dev:api    # Bun API
# Open http://localhost:5173, sign in with Google test account
# Verify: /auth/me returns account + plan free_unverified
```

Expected: Google PKCE login works, session cookie is HttpOnly/Secure/SameSite, and a second signed-out browser cannot call any owned endpoint.

### 2. RLS isolation (automated)

```bash
bun run test:isolation
```

Expected: green. Two accounts created; each account's queries return zero rows of the other's data; policy blocks direct role escalation (see [data model, RLS](../data-model.md)).

### 3. Passive free assessment (no verification)

- Create assessment: category `surface`, target `example.com`, playbook `surface-public-posture`.
- No HTTP verification required for passive slice.
- Wait for `completed`; dashboard shows aggregated posture only.

Expected: `queued -> running -> analyzing -> completed` (or `failed` with reason); no active-test actions; in-product notification `assessment_completed`; free-unverified cannot see finding detail (only aggregate).

### 4. Active test requires verification

- Create assessment with active slice. It must enter `awaiting_verification`.
- Without placing the challenge file, status stays `awaiting_verification`; submit fails or retries.
- Place the challenge token file on the target origin (or add the `_tma-<service>-challenge.<domain>` TXT record for a non-HTTP target), resubmit, and confirm `verified`.
- Confirm the fetch policy rejected a localhost/192.168.x.x verification URL (SSRF-safe; see [research R8](../research.md)).

Expected: active execution never begins before `verified`; SSRF-literal/private targets rejected.

### 5. Queue durability and policy enforcement

- Kill the control worker mid-run; restart it.
- Confirm a leased job is recovered (`stale_recovered`) and eventually completes or fails with reason - never stuck (SC-004).
- Launch a second assessment for the same target/account: rejected (one execution per target/account).

### 6. Entitlement via webhook only (Stripe test)

```bash
stripe listen --forward-to localhost:3001/api/v1/webhooks/stripe
# complete a checkout.session in test mode (Pix or card)
```

Expected: webhook signature verified (raw body), dedupe insert on `stripe_event_id`, entitlement flips to `pro` exactly once; replaying the same event id changes nothing (SC-005). Browser checkout page only began intent; no client-side entitlement logic.

### 7. Plan gating on findings and reports

- Free verified: dashboard finding shows title/category/severity only; `/reports` returns empty or 403.
- Paid (`pro`): evidence + reproduction + PDF technical + PDF executive + JSON available; JSON matches [export contract](../contracts/export.md) and contains no secrets (SC-009).

### 8. Private agent internal target

- Install agent in a controlled environment; connect outbound via `WS /agents/connect`.
- Onboarding shows unique token, fingerprint, status, last activity, revocation.
- Dispatch internal job to agent; artifacts return; internal credentials never reach the server (SC-007).
- Revoke agent; next job dispatch refused (FR-017).

## Notes

- Each scenario references the authoritative definitions in [contracts](../contracts/index.md) and the [data model](../data-model.md); treat drift from those as a bug.
- These scenarios map 1:1 to acceptance criteria SC-001..SC-010 in [spec.md](../spec.md).
- AI-provider fallback: with external AI disabled or unreachable, `analyzing` must still resolve via deterministic triage (no hard block).