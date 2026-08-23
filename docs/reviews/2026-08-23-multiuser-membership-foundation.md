# Multi-user membership foundation review

**Status:** T071–T075 implemented and verified on `feat/foundation-phase2`.

This checkpoint covers the additive membership foundation only. The complete
lifecycle API, browser UI, queue/outbox, and staff admin plane remain pending
for T076–T094.

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

## Verification evidence

Run from the repository root with Bun 1.4.0:

| Gate | Result |
| --- | ---: |
| Contract tests | 35 passed |
| Unit tests | 262 passed |
| PostgreSQL integration (fresh `_test`, sequential) | 63 passed |
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

T076 still needs the full membership lifecycle mutations (role/status/remove,
last-owner transaction integration, and account deletion revocation) plus their
database store adapters. T077–T080 cover the remaining RLS cutover review,
server-driven web controls, expand-contract evidence, and the aggregate
acceptance gate. Queue/outbox and staff admin work starts only after that gate.
