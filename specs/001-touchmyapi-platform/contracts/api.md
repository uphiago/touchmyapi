# API Contract v1

Base path: `/api/v1`. Auth: HttpOnly session cookie (Google OAuth PKCE). JSON everywhere. Errors: `{ "error": { "code", "message", "field?" } }`. All mutations validate schema, ownership, state, entitlement, and policy engine before applying (spec FR-014). IDs never grant access.

## Session

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/auth/login` | start Google OAuth PKCE (redirect) |
| GET | `/auth/callback` | exchange code; set session cookie |
| POST | `/auth/logout` | revoke session |
| GET | `/auth/me` | current user + account (id, email, plan, iaEnabled) |

## Assessment

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/assessments` | create from guided modal payload (category → target → scope → limits → playbook → attestation) |
| GET | `/assessments` | list for account (status, scope summary, plan-permitted finding count, timeline, credits) |
| GET | `/assessments/:id` | detail; field visibility gated by plan |
| POST | `/assessments/:id/cancel` | idempotent transition; stop signal + cleanup for active runner |
| GET | `/assessments/:id/verification` | current verification record for active external run |
| POST | `/assessments/:id/verification` | (re)submit HTTP-file or DNS-TXT challenge |
| GET | `/assessments/:id/findings` | plan-permitted findings (free-verified: title/category/severity only) |
| GET | `/assessments/:id/reports` | list report objects (kind, generated_at, url) |
| GET | `/assessments/:id/reports/:reportId/download` | single-use signed URL |

## Playbooks (catalog)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/playbooks` | active playbook catalog by category (limits, credit estimate, impact levels) |

## Billing

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/billing/checkout` | create server-side order + Stripe Checkout session intent (one-off Pix/card or Pro subscription); returns URL. No entitlement logic in browser. |
| GET | `/billing/portal` | Stripe customer portal URL (subscription management) |
| GET | `/billing/entitlement` | current plan, status, expiry, credits balance |
| POST | `/webhooks/stripe` | signature-verified webhook intake (raw body) - public endpoint, no session |

## Agents (private)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/agents` | create agent identity (token + fingerprint shown once) |
| GET | `/agents` | list (name, status, fingerprint, last_seen) |
| POST | `/agents/:id/revoke` | revoke identity |
| WS | `/agents/connect` | outbound authenticated agent channel to control worker |

## Notifications

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/notifications` | in-product notifications |
| POST | `/notifications/:id/read` | mark read |

## Signed URL flow

1. Client requests report download for an owned, plan-permitted report.
2. API validates ownership + entitlement, then mints a short-lived presigned URL (signed by object storage) scoped to the object. No public bucket; no long-lived URL returned (spec FR-003, FR-012).