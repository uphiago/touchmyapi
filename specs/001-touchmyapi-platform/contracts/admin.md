# Admin Control Plane Contract v1

The admin app/API has a separate origin, API base path, cookies, CSRF policy, and audit stream backed by `staff_identity`, `staff_mfa_factor`, `staff_session`, `staff_role_assignment`, `support_access_grant`, `support_access_approval`, and `admin_audit_event`. Customer Google sessions cannot authenticate to it. Staff bootstrap is an out-of-band CLI/migration-owner operation keyed by immutable Google Workspace subject; a domain alone is insufficient. Staff login uses separate Google OIDC and local WebAuthn MFA. One-time recovery material is hashed; MFA reset requires dual approval.

## Staff and capability grant

Staff sessions require MFA. A `support_access_grant` contains `staffIdentityId`, `accountId`, a closed capability, `reason`, `ticketReference`, `requestedAt`, `approvedAt`, `expiresAt`, and status; approvals are separate `support_access_approval` rows. A normal grant requires one distinct approver; `break_glass` requires two distinct approvals and a short TTL. Grants are deny-by-default and expire automatically.

Allowed queue capabilities are policy-aware metadata/status actions: inspect queue metadata, cancel a job, requeue a failed/stale job, and trigger reaper processing. Admin cannot change target/scope, dispatch arbitrary actions, execute a runner, or bypass the policy engine.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/admin/auth/login` | start separate staff Google OIDC |
| GET | `/admin/auth/callback` | complete staff OIDC; do not accept customer session |
| POST | `/admin/auth/mfa/verify` | establish or refresh staff MFA session |
| POST | `/admin/auth/webauthn/register/options` | issue WebAuthn registration challenge |
| POST | `/admin/auth/webauthn/register` | register staff MFA factor |
| POST | `/admin/auth/webauthn/assert/options` | issue WebAuthn assertion challenge |
| POST | `/admin/auth/webauthn/assert` | verify assertion and refresh MFA |
| POST | `/admin/auth/recovery/verify` | consume one-time hashed recovery material; MFA reset still needs dual approval |
| POST | `/admin/auth/mfa/reset/request` | request dual-approved MFA reset |
| POST | `/admin/auth/mfa/reset/approve` | second staff approval for reset |
| POST | `/admin/auth/logout` | revoke the separate staff session and clear the admin cookie |
| POST | `/admin/capability-grants` | request a reasoned, ticketed, TTL-bound tenant grant |
| POST | `/admin/capability-grants/:id/approve` | approve normal grant; second approval required for break-glass |
| GET | `/admin/accounts/:accountId/queue` | policy-permitted queue metadata/status only |
| POST | `/admin/accounts/:accountId/jobs/:jobId/cancel` | policy-permitted cancellation with active grant |
| POST | `/admin/accounts/:accountId/jobs/:jobId/requeue` | policy-permitted requeue with reason; clears lease but never resets fencing |
| POST | `/admin/reaper/run` | trigger bounded stale-lease recovery |
| GET | `/admin/billing/:accountId` | read-only entitlement/billing event status |

## Mandatory denials

There is no impersonation endpoint, owner/BYPASSRLS role, arbitrary SQL endpoint, secret/raw-evidence endpoint, billing mutation, credit grant, entitlement override, or unbounded queue operation. Missing MFA, grant, approval, ticket, reason, TTL, membership/account policy, or fencing token returns `403` and appends a redacted admin audit event. Admin audit is append-only and includes staff actor, account, grant, ticket, reason, operation, outcome, and request ID.

`admin_audit_event` stores `id`, nullable `account_id` (NULL only for the system/bootstrap boundary), nullable `staff_identity_id`, nullable `staff_session_id`, nullable `grant_id`, nullable `approval_id`, `request_id`, closed `action`, safe subject type/id, ticket/reference and reason, outcome, redacted payload, `prev_event_hash`, `event_hash`, and `created_at`. Foreign keys point to the named staff/session/grant/approval tables; each account and the system boundary has an independent canonical hash chain. Runtime roles may insert through the audit writer but cannot update/delete, cross-link tenant chains, or bypass RLS. An audit write failure fails closed for security-sensitive admin mutations.
