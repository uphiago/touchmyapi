# Phase 2A Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit account membership, invitation acceptance, active-account session binding, and membership-enforced API/RLS without replacing the existing global `user` identity.

**Architecture:** Keep `user(provider, provider_subject)` as the only customer identity authority and preserve legacy `user.account_id` during an expand-contract migration. Add `account_membership` and `account_invitation` with tenant-scoped `account_id` plus immutable `user.id` identity references; composite tenant references are reserved for session/attestation cutover paths so the legacy unique `user.account_id` cannot block one user joining multiple accounts. All customer authorization resolves from `session.account_id` plus an active membership. Authentication/account switching uses narrow fixed-signature bootstrap functions and rotates the opaque session token. API and UI consume server-derived account/role data; no email linking, URL bearer tokens, arbitrary SQL, or browser-side authorization decisions are introduced.

**Tech Stack:** Bun 1.4, TypeScript strict, Zod, Vitest, Drizzle, PostgreSQL 16, postgres.js, Hono, React/Vite, existing RLS/policy/audit boundaries.

---

## Required order and database discipline

Run membership work after the accepted foundation commit `79419ab` and before any T022 assessment work. Each task follows RED → verify failure → minimal GREEN → focused verification → commit. Use a fresh database ending in `_test`, run database suites sequentially with `--maxWorkers=1`, and inspect the Drizzle journal before creating a migration; never guess a migration number.

```bash
export PATH=/home/hiago/.bun/bin:$PATH
export DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_phase2a_membership_test
```

The provider boundary remains Google-only per the approved spec. Provider configuration is injectable and mockable; GitHub/X stay disabled until a separate scope/spec change adds a second identity-provider policy.

## Task 1 — T071 membership contracts

**Files:** create `packages/contracts/src/membership.ts`, `packages/contracts/test/membership.test.ts`; modify `packages/contracts/src/index.ts`, `specs/001-touchmyapi-platform/contracts/membership.md`.

- [x] Write tests first for strict roles `owner|admin|operator|viewer|billing`, statuses `active|suspended|removed`, invitation create/accept, account list/switch, and stable errors. Every object must reject unknown keys; only the explicit accept body may contain `token`.
- [x] Run `bun run test:contract -- membership`; it must fail because the module/export is absent.
- [x] Implement frozen Zod schemas and inferred types. Use UUID strings for IDs, bounded ISO dates, and stable error codes `invalid_invitation`, `membership_required`, `membership_suspended`, `active_account_required`, `last_owner_protected`.
- [x] Run `bun run test:contract -- membership && bun run typecheck`; expect all membership tests and strict typing to pass.
- [x] Commit `contracts: define user membership and invitation` with only contract paths.

## Task 2 — T072 additive membership schema and backfill

**Files:** create `packages/db/schema/membership.ts`, `packages/db/test/membership-schema.integration.test.ts`; modify `packages/db/schema/index.ts`, generated migration under `packages/db/migrations/`.

- [x] Write integration tests asserting `account_membership(account_id,user_id)`, `account_invitation`, immutable `user.id` identity FKs plus explicit tenant `account_id`, unique `(account_id,user_id)`, multiple active owners, token-hash-only invitation storage, and no second identity table. Run the focused integration command and verify the expected pre-migration failure.
- [x] Inspect `packages/db/drizzle/meta/_journal.json` and highest migration. Generate the next migration with `bunx drizzle-kit generate --config=drizzle.config.ts --name multiuser_membership` against the fresh `_test` URL; inspect SQL before applying it. Because legacy `user.account_id` remains unique during expand, membership identity columns use immutable simple `user.id` FKs plus tenant `account_id`; composite tenant FKs are added to session/attestation and later cutover paths.
- [x] Add additive tables and nullable/expand columns only. Backfill exactly one `owner` membership per valid legacy `user.account_id`; quarantine orphan legacy rows explicitly and never match by email. Keep `user.account_id` and its unique constraint during expand.
- [x] Apply migrations, run `RUN_DB_TESTS=1 bun run test:integration -- --maxWorkers=1 membership-schema`, then rerun `bun run db:migrate` to prove Drizzle journal no-op behavior and replay `0012_membership_identity_fk.sql` as raw SQL to prove the correction block is SQL-idempotent too.
- [x] Commit `db: add account membership expand migration` with schema, migration, and focused integration test paths.

## Task 3 — T073 role capability policy

**Files:** create `packages/policy/src/membership.ts`, `packages/policy/test/membership.test.ts`; modify `packages/policy/src/index.ts`.

- [x] Write table-driven RED tests for each role and active/suspended/removed status. Owner/admin manage members; operator creates/cancels assessments; viewer reads; billing reads billing and can initiate purchase intent only. Test account/user binding and deny unknown role/status.
- [x] Run `bun run test:unit -- membership`; verify failure before implementation.
- [x] Implement immutable role capability sets keyed by the supplied `accountId` and `userId`; make the last-active-owner guard an explicit decision returned to the transaction layer, not an index shortcut. Freeze outputs and deny by default.
- [x] Run `bun run test:unit -- membership && bun run typecheck`.
- [x] Commit `policy: enforce membership role capabilities`.

## Task 4 — T074 account list/switch and session binding

**Files:** modify `packages/db/src/auth-bootstrap.ts`, `packages/db/src/session.ts`, generated auth migration; create `apps/api/test/account-session.test.ts`.

- [x] Write RED tests for `auth_list_accounts(session_hash)` safe fields, `auth_switch_account(current_hash,target_account_id,new_hash,expiry)` active-membership enforcement, old-token invalidation, `session.account_id` authority, and denial of arbitrary account enumeration.
- [x] Run `bun run test:unit -- account-session`; verify failure before changing production code.
- [x] Add fixed-search-path, `auth_bootstrap`-owned functions with fixed signatures. Update the typed session store to list/switch by hash, preserve `user.account_id` during expand, and rotate old/new hashes atomically. Do not expose raw SQL or email lookup.
- [x] Run focused unit tests, `bun run typecheck`, and the auth bootstrap integration assertions.
- [x] Commit `auth: add narrow account list and switch`.

## Task 5 — T075 hashed invitations and explicit acceptance

**Files:** create `packages/db/src/invitations.ts`, `packages/db/migrations/0015_invitations.sql`, `packages/db/test/invitations.unit.test.ts`; mount the authenticated HTTP boundary in `apps/api/src/auth.ts` so raw tokens enter only the explicit body boundary.

- [x] Write RED tests for 32 random bytes, SHA-256-only persistence, no URL token, redaction before access/app logs, expiry/revocation/replay, same-user idempotency, other-user generic invalid result, and equal-email non-linking.
- [x] Run the focused invitation integration command and verify failure before implementation.
- [x] Implement owner/admin creation and the fixed auth-bootstrap acceptance function plus the `POST /api/v1/invitations/accept` body route. Lock the invitation, validate authenticated `user_id`, expiry/status/hash, insert membership, set `accepted_by_user_id`, rotate `session.account_id`, and append an audit event atomically. Return generic invalid results; same accepted user replays idempotently.
- [x] Run focused integration tests, `bun run typecheck`, and a grep proving token values never enter URLs/logs/audit payloads.
- [x] Commit `feat: accept hashed invitations explicitly`.

## Task 6 — T076 membership lifecycle API

**Files:** create `apps/api/src/memberships.ts`, `apps/api/test/memberships.test.ts`, `packages/db/migrations/0016_membership_lifecycle.sql`; modify `apps/api/src/app.ts`, `apps/api/src/auth.ts`, and membership contracts/tests.

- [ ] Write RED tests for list/invite/accept/role/status/remove/switch, membership-required errors, path-account mismatch, suspended membership, active role capabilities, and last-owner transactional protection.
- [ ] Run `bun run test:unit -- memberships-api`; verify failure before implementation.
- [ ] Mount routes behind the existing API audit/CORS/error boundary. Resolve the active account only from the server session, require active membership and policy capability, audit mutations, and reject URL account IDs that differ from `session.account_id`. Support multiple owners and deny only the last active-owner removal/demotion. Account deletion must revoke sessions/agents and retain audit history.
- [ ] Run focused API tests, full unit tests, typecheck, and web build if route contracts change.
- [ ] Commit `api: enforce membership lifecycle`.

**Current checkpoint:** the API boundary slice is implemented and tested. It
uses canonical list/invite/patch/remove routes, validates the session account
and active membership, rejects suspended sessions, protects owner transitions,
and passes redacted audit metadata plus a one-time delivery token into an
atomic store/outbox boundary. The PostgreSQL functions now append invitation
creation, invitation acceptance, and membership mutations to the locked audit
chain; removal revokes target sessions in the same transaction. A production
store adapter, account deletion workflow, and browser UI remain part of T076–
T080 and are intentionally not marked complete yet.

## Task 7 — T077 membership RLS and session/attestation composite references

**Files:** generated migration; modify `packages/db/schema/assessment.ts` and `packages/db/schema/identity.ts`; create `tests/isolation/multiuser-rls.test.ts`.

- [ ] Write RED isolation tests with two accounts/users proving membership, invitation, session, assessment, and attestation cannot cross-read/write/reference with missing or wrong tenant context.
- [ ] Run `RUN_DB_TESTS=1 bun run test:isolation -- --maxWorkers=1 multiuser-rls`; verify the expected failure before migration/policy changes.
- [ ] Extend the already-forced membership RLS policies and add composite `(account_id,user_id)` references only where session/attestation rows need tenant-bound actors. Membership identity columns remain immutable `user.id` FKs plus explicit tenant `account_id` so one global user can join multiple accounts while legacy `user.account_id` is still unique. Keep global user lookup only inside fixed auth functions.
- [ ] Apply migration and run the full isolation project sequentially on the fresh `_test` database; verify table grants and role attributes.
- [ ] Commit `security: enforce membership rls boundaries`.

## Task 8 — T078 server-driven account UI

**Files:** modify `packages/ui/api-client.ts`; create `apps/web/src/account-switcher.tsx`, `apps/web/src/memberships.tsx`, `apps/web/src/memberships.test.tsx`.

- [ ] Write RED component tests for account list/active account, role labels, invitation create/explicit accept form, no token URL construction/echo, and no browser authorization decisions.
- [ ] Run `bun test apps/web/src/memberships.test.tsx`; verify failure before implementation.
- [ ] Implement API-derived views and `POST /api/v1/invitations/accept` body submission. Account switching must call the server and consume the rotated session; UI only renders server decisions.
- [ ] Run the component tests and `(cd apps/web && bun run build)`.
- [ ] Commit `web: add explicit account membership controls`.

## Task 9 — T079 expand-contract review

**Files:** create `tests/integration/multiuser-migration.test.ts`, `docs/reviews/2026-08-23-multiuser-membership.md`; modify `specs/001-touchmyapi-platform/quickstart.md`.

- [ ] Write RED migration tests for legacy `user.account_id` preservation, owner backfill, session account backfill, dual-read authorization, and explicit orphan quarantine.
- [ ] Run the focused migration integration command and verify failure before the review implementation exists.
- [ ] Document journal inspection, dual-read, first-request session rotation, cutover, rollback, and the later removal gate for legacy columns. Do not remove `user.account_id` in this phase.
- [ ] Run migration and focused integration evidence on a fresh database; commit `docs: review membership expand contract`.

## Task 10 — T080 membership acceptance gate

**Files:** create `docs/reviews/2026-08-23-multiuser-membership-acceptance.md`; modify tasks/checkpoint/quickstart docs.

- [ ] Run unit, contract, integration, and isolation projects sequentially with the fresh `_test` URL; record exact counts and any intentionally pending e2e test.
- [ ] Review FR-022/FR-023/SC-011/SC-012/SC-013 evidence: active membership/roles, multiple owners and last-owner guard, body-token redaction, auth list/switch, legacy expand-contract, user-only identity, and RLS isolation.
- [ ] Update task checkboxes only after evidence is green, document GitHub/X as still model-disabled and provider mocks as injectable, run typecheck/lint/format/web build/Compose/diff checks, and commit `docs: accept multiuser membership gate`.

## Final review handoff

After T080 passes, ask a spec reviewer and a quality reviewer to read the aggregate T071–T080 range. Fix every finding, rerun the complete gate, push `feat/foundation-phase2`, and only then begin T081. No queue/admin implementation belongs in this membership plan.
