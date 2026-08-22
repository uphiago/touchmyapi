# Admin Control Plane Contract v1

The admin app/API has a separate origin, API base path, staff identity, MFA challenge, session cookie, CSRF policy, and audit stream. Customer Google sessions cannot authenticate to it.

## Staff and capability grant

Staff sessions require MFA. A tenant capability grant contains `staffIdentityId`, `accountId`, a closed capability, `reason`, `ticketReference`, `requestedAt`, `approvedAt`, `expiresAt`, `approverIdentityId`, and status. A normal grant requires one distinct approver; `break_glass` requires two distinct approvals and a short TTL. Grants are deny-by-default and expire automatically.

Allowed queue capabilities are policy-aware metadata/status actions: inspect queue metadata, cancel a job, requeue a failed/stale job, and trigger reaper processing. Admin cannot change target/scope, dispatch arbitrary actions, execute a runner, or bypass the policy engine.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/admin/auth/mfa/verify` | establish or refresh staff MFA session |
| POST | `/admin/capability-grants` | request a reasoned, ticketed, TTL-bound tenant grant |
| POST | `/admin/capability-grants/:id/approve` | approve normal grant; second approval required for break-glass |
| GET | `/admin/accounts/:accountId/queue` | policy-permitted queue metadata/status only |
| POST | `/admin/accounts/:accountId/jobs/:jobId/cancel` | policy-permitted cancellation with active grant |
| POST | `/admin/accounts/:accountId/jobs/:jobId/requeue` | policy-permitted requeue with reason and fencing reset |
| POST | `/admin/reaper/run` | trigger bounded stale-lease recovery |
| GET | `/admin/billing/:accountId` | read-only entitlement/billing event status |

## Mandatory denials

There is no impersonation endpoint, owner/BYPASSRLS role, arbitrary SQL endpoint, secret/raw-evidence endpoint, billing mutation, credit grant, entitlement override, or unbounded queue operation. Missing MFA, grant, approval, ticket, reason, TTL, membership/account policy, or fencing token returns `403` and appends a redacted admin audit event. Admin audit is append-only and includes staff actor, account, grant, ticket, reason, operation, outcome, and request ID.
