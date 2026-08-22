# Membership and Invitation Contract v1

Customer authentication resolves a global immutable Google identity. Every business request then requires an active `account_membership`; the account/workspace is the RLS tenant. Email is display/contact data only and never links an identity automatically.

## Roles and capabilities

| Role | Allowed capabilities |
| --- | --- |
| `owner` | account lifecycle, membership/invitation administration, assessments, queue actions allowed by policy, billing view and purchase-intent initiation; entitlement changes remain webhook-only |
| `admin` | membership/invitation administration and assessments; no account ownership transfer without owner policy; billing read-only |
| `operator` | create, view, and cancel assessments within policy; view permitted findings/reports |
| `viewer` | view account data permitted by plan; no mutations |
| `billing` | read billing, entitlement, invoice, and credit status and initiate an allowed purchase intent; no assessment, membership, or entitlement mutation |

Membership status is `active`, `suspended`, or `removed`. Unknown roles/statuses deny all capabilities. The last active owner cannot be removed or demoted without an explicit owner-transfer transaction.

## Invitation

```jsonc
{
  "accountId": "uuid",             // derived from active session, not trusted from browser
  "email": "person@example.test",  // contact/display only
  "role": "operator",
  "expiresAt": "2026-08-29T12:00:00Z"
}
```

The API generates at least 256 bits of random token, stores only `sha256(token)`, and returns the raw token once through the delivery boundary. Acceptance requires an authenticated global identity, explicit user action, an unexpired unused hash, and account policy. Equal email does not accept or link an identity. Acceptance inserts membership, marks the invitation used, appends an audit event, and rotates the active-account session atomically.

Invalid, expired, used, and mismatched tokens return the same generic `invalid_invitation` error without an existence oracle. Invitation hashes and raw tokens never appear in logs, audit payloads, exports, or frontend state.

## Account and session endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/accounts` | list accounts with active membership role |
| POST | `/accounts/:accountId/memberships/invitations` | owner/admin creates an invitation |
| POST | `/invitations/:token/accept` | authenticated identity explicitly accepts |
| GET | `/accounts/:accountId/memberships` | owner/admin list members; other roles receive policy-permitted view |
| PATCH | `/accounts/:accountId/memberships/:identityId` | owner/admin changes role/status with last-owner guard |
| DELETE | `/accounts/:accountId/memberships/:identityId` | owner/admin removes membership with last-owner guard |
| POST | `/account/switch` | validates membership, rotates session, sets active account server-side |

All paths enforce active session, membership, RLS tenant context, schema, policy, state, and append-only audit. IDs never grant access.
