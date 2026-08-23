# Multi-user membership foundation review

**Status:** T071–T075 implemented; the T076 lifecycle API boundary slice is
implemented and verified on `feat/foundation-phase2`.

This checkpoint covers the additive membership foundation and the T076 API
boundary slice. The production lifecycle database adapter, browser UI,
queue/outbox, and staff admin plane remain pending for T076–T094.

## Delivered boundary

- The existing global `user(provider, provider_subject)` identity remains the
  only identity authority. Membership rows reference immutable `user.id` and
  carry an explicit tenant `account_id`.
- `account_membership` and hash-only `account_invitation` tables are additive;
  the legacy `user.account_id` column remains during expand-contract.
- Owner/admin/operator/viewer/billing capabilities are immutable, active-status
  checked, and default-deny. Owner billing purchase capability and the
  count-based last-owner guard are covered by policy tests.
- Auth bootstrap list/switch functions derive the source account from the
  active session and membership, rotate opaque session hashes atomically, and
  reject suspended or stale source memberships.
- Invitation creation and acceptance use 32 random bytes, SHA-256 persistence,
  generic invalid results, single-use locking, same-user idempotent replay,
  role-preserving conflicts, and redacted audit payloads. The raw token is
  accepted only by the explicit JSON body route and never appears in URL or
  audit data.
- `GET /api/v1/accounts` (with a compatibility singular alias), account switch,
  and invitation acceptance are mounted behind credentialed CORS and the
  existing audit/error boundary. Stores are injected, so local tests and
  deployments without provider or billing credentials can use mocks.

## T076 boundary slice

- `GET /api/v1/accounts/:accountId/memberships`, invitation creation, canonical
  membership `PATCH`, and removal are exposed behind the authenticated Hono
  boundary. URL account IDs must match the server-resolved session account.
- Session resolution requires an active membership; suspended and removed
  memberships fail closed. Owner/admin checks and owner-transition rules are
  explicit, including the last-active-owner guard.
- Mutation contracts carry an audit event and invitation delivery token into a
  store boundary that must commit audit/outbox effects atomically. The current
  unit fixture is mockable by design; no provider or delivery credential is
  needed for local tests.
- Migration `0016_membership_lifecycle.sql` revokes removed-user sessions and
  appends invitation-created, invitation-accepted, and membership events using
  the locked per-account audit chain.

## Verification evidence

Run from the repository root with Bun 1.4.0:

| Gate | Result |
| --- | ---: |
| Contract tests | 36 passed |
| Unit tests | 267 passed |
| PostgreSQL integration (fresh `_test`, sequential) | 64 passed |
| Isolation project (fresh `_test`, sequential) | 22 passed |
| TypeScript | passed |
| ESLint | passed |
| Prettier check | passed |
| `git diff --check` | passed |

The real Google OIDC adapter remains injectable and requires production
credentials only at deployment. GitHub/X login remains model-disabled by the
approved launch policy; adding credentials alone does not enable those
providers.

## Explicitly pending

T076 still needs a production database store/outbox adapter and the account
deletion revocation workflow; the route and SQL transaction boundary are
present. T077–T080 cover the remaining RLS cutover review, server-driven web
controls, expand-contract evidence, and the aggregate acceptance gate.
Queue/outbox and staff admin work starts only after that gate.
