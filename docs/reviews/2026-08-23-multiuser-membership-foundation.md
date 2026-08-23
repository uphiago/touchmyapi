# Multi-user membership foundation review

**Status:** T071–T075, T077, and T078 are implemented and verified on
`feat/foundation-phase2`; T076 remains a boundary slice pending its production
store/deletion adapter.

This checkpoint covers the additive membership foundation, the T076 API
boundary slice, the T077 database isolation cut, and the T078 server-driven
workspace UI. The production lifecycle database adapter, expand-contract
review, acceptance gate, queue/outbox, and staff admin plane remain pending for
T076 and T079–T094.

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
| Unit tests | 274 passed |
| PostgreSQL integration (fresh `_test`, sequential) | 64 passed |
| Isolation project (fresh `_test`, sequential) | 24 passed |
| TypeScript | passed |
| ESLint | passed |
| Prettier check | passed |
| `git diff --check` | passed |

## T077 RLS and composite-reference slice

- Migration `0017_multiuser_rls_references.sql` adds composite
  `(account_id,user_id)` foreign keys from `session` and
  `authorization_attestation` to `account_membership`, while retaining the
  global `user` identity foreign keys used by fixed authentication functions.
- `account_membership` is explicitly included in the API tenant privilege
  allowlist. Invitation reads are column-scoped and deliberately exclude
  `token_hash`; invitation writes remain behind fixed `SECURITY DEFINER`
  functions.
- `tests/isolation/multiuser-rls.test.ts` proves two-account membership and
  invitation isolation plus cross-account session/attestation reference
  rejection. The schema integration matrix and role preflight assertions cover
  the new constraints and grants.
- The full isolation project passes 24/24 and the full PostgreSQL integration
  project passes 64/64 on separate freshly migrated databases.

## T078 server-driven workspace UI

- `packages/ui/api-client.ts` validates account, membership, invitation, and
  stable error responses through the existing Zod contracts and uses
  credentialed requests for every call.
- `AccountSwitcher` consumes the server account snapshot and delegates account
  changes to `POST /api/v1/account/switch`; it never grants or infers access in
  the browser.
- `Memberships` renders server-provided role/status rows, invitation creation,
  and explicit body-only acceptance. The raw token is cleared immediately after
  submission and is never rendered or added to a URL.
- The Vite shell now has a responsive dark industrial workspace treatment with
  keyboard focus states, reduced-motion support, loading/empty/error states,
  and server-authoritative mutation refreshes.
- The full unit project passes 274/274 and the production web build passes.
- The local runtime path was exercised with `bun run dev:local` and
  `bun run local:smoke`: API health and the Vite shell both returned PASS while
  PostgreSQL was running. PostgreSQL logs showed readiness to accept
  connections; the API/Vite processes were then stopped with Ctrl-C and the
  database volume was preserved.

The real Google OIDC adapter remains injectable and requires production
credentials only at deployment. GitHub/X login remains model-disabled by the
approved launch policy; adding credentials alone does not enable those
providers.

## Explicitly pending

T076 still needs a production database store/outbox adapter and the account
deletion revocation workflow; the route and SQL transaction boundary are
present. T079–T080 cover the expand-contract evidence and aggregate acceptance
gate.
Queue/outbox and staff admin work starts only after that gate.
