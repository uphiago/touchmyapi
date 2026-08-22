# Membership and Invitation Contract v1

Customer authentication resolves the existing global immutable Google `user` row. Every business request then requires an active `account_membership(account_id,user_id)`; the account/workspace is the RLS tenant. Email is delivery/contact data only and never links a user automatically.

## Roles and capabilities

| Role | Allowed capabilities |
| --- | --- |
| `owner` | account lifecycle, membership/invitation administration, assessments, queue actions allowed by policy, billing view and purchase-intent initiation; entitlement changes remain webhook-only |
| `admin` | membership/invitation administration and assessments; no account ownership transfer without owner policy; billing read-only |
| `operator` | create, view, and cancel assessments within policy; view permitted findings/reports |
| `viewer` | view account data permitted by plan; no mutations |
| `billing` | read billing, entitlement, invoice, and credit status and initiate an allowed purchase intent; no assessment, membership, or entitlement mutation |

Membership status is `active`, `suspended`, or `removed`. Multiple active owners are allowed. Unknown roles/statuses deny all capabilities. The last active owner cannot be removed or demoted; the transaction must lock and count active owners before changing role/status.

## Invitation

```jsonc
{
  "accountId": "uuid",             // derived from active session, not trusted from browser
  "email": "person@example.test",  // contact/display only
  "role": "operator",
  "expiresAt": "2026-08-29T12:00:00Z"
}
```

The API generates a 256-bit bearer token, stores only `sha256(token)`, and returns the raw token once through the delivery boundary. Email is delivery only. Acceptance is `POST /invitations/accept` with a JSON body containing the bearer token; the body is redacted before access logs, request logs, traces, or audit payloads. It requires an authenticated `user`, explicit user action, an unexpired unused hash, and account policy. Equal email does not accept or link a user. Acceptance inserts membership, marks the invitation used with `accepted_by_user_id`, appends an audit event, and rotates `session.account_id` atomically.

Invalid, expired, revoked, and mismatched tokens, or a token presented by another user, return the same generic `invalid_invitation` error without an existence oracle. A replay by the same `accepted_by_user_id` returns the prior idempotent acceptance result and does not duplicate membership/audit effects. Invitation hashes and raw tokens never appear in logs, audit payloads, exports, or frontend state.

## Account and session endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/accounts` | list accounts with active membership role |
| POST | `/accounts/:accountId/memberships/invitations` | owner/admin creates an invitation |
| POST | `/invitations/accept` | authenticated user explicitly accepts token in redacted body |
| GET | `/accounts/:accountId/memberships` | owner/admin list members; other roles receive policy-permitted view |
| PATCH | `/accounts/:accountId/memberships/:userId` | owner/admin changes role/status with last-owner guard |
| DELETE | `/accounts/:accountId/memberships/:userId` | owner/admin removes membership with last-owner guard |
| POST | `/account/switch` | validates membership, rotates session, sets active account server-side |

All paths enforce active session, membership, RLS tenant context, schema, policy, state, and append-only audit. IDs never grant access.
