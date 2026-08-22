# API Contract v1

Base path: `/api/v1`. Auth: HttpOnly customer session cookie (Google OAuth PKCE) bound to one active `session.account_id`. JSON everywhere. Errors: `{ "error": { "code", "message", "field?" } }`. All mutations validate schema, active `account_membership(account_id,user_id)`, state, entitlement, and policy engine before applying (spec FR-014/FR-022). IDs never grant access.

## Session

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/auth/login` | start Google OAuth PKCE (redirect) |
| GET | `/auth/callback` | exchange code; set session cookie |
| POST | `/auth/logout` | revoke session |
| GET | `/auth/me` | current global `user` + active account/membership (id, email, role, plan, iaEnabled) |

## Accounts and membership

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/accounts` | list safe account/member fields for the authenticated user via narrow bootstrap function |
| GET | `/accounts/:accountId/memberships` | list policy-permitted members |
| POST | `/accounts/:accountId/memberships/invitations` | owner/admin creates a token-hash invitation |
| POST | `/invitations/accept` | explicit authenticated acceptance with redacted bearer token body; rotates `session.account_id` |
| PATCH | `/accounts/:accountId/memberships/:userId` | owner/admin role/status change with last-owner guard |
| DELETE | `/accounts/:accountId/memberships/:userId` | owner/admin removal with session revocation |
| POST | `/account/switch` | validate membership and rotate session to the selected account |

`POST /account/switch` accepts `{ "accountId": "uuid" }`; the server validates the current session hash and membership through the narrow `auth_switch_account` function, rotates the session token, and never accepts a browser-only tenant selector.

## Assessment

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/assessments` | create from guided modal payload (category → target → scope → limits → playbook → attestation) |
| GET | `/assessments` | list for account (status, scope summary, plan-permitted finding count, timeline, credits) |
| GET | `/assessments/:id` | detail; field visibility gated by plan |
| POST | `/assessments/:id/cancel` | idempotent transition; stop signal + cleanup for active runner |
| GET | `/assessments/:id/verification` | current verification record for active external run |
| POST | `/assessments/:id/verification` | (re)submit HTTP-file challenge; DNS-TXT is modeled but disabled at launch |
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

## Admin control plane

Admin uses a separate origin/API and cookies; these routes are not customer routes and require staff MFA plus an unexpired capability grant. Billing is read-only.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/admin/auth/mfa/verify` | establish/refresh staff MFA session |
| POST | `/admin/capability-grants` | request reason/ticket/TTL-bound tenant capability |
| POST | `/admin/capability-grants/:id/approve` | approve; break-glass needs two distinct approvers |
| GET | `/admin/accounts/:accountId/queue` | policy-aware queue metadata/status |
| POST | `/admin/accounts/:accountId/jobs/:jobId/cancel` | policy-aware cancellation only |
| POST | `/admin/accounts/:accountId/jobs/:jobId/requeue` | policy-aware stale/failed requeue |
| POST | `/admin/reaper/run` | trigger bounded lease recovery |
| GET | `/admin/billing/:accountId` | read-only billing/entitlement state |

Admin has no impersonation, owner/BYPASSRLS, arbitrary SQL, secret/raw-evidence, credit-grant, or entitlement-write endpoint.

## Signed URL flow

1. Client requests report download for an owned, plan-permitted report.
2. API validates ownership + entitlement, then mints a short-lived presigned URL (signed by object storage) scoped to the object. No public bucket; no long-lived URL returned (spec FR-003, FR-012).
