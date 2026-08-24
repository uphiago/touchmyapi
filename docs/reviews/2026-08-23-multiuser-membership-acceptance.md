# Multi-user membership acceptance gate

**Status:** T080 complete for the membership foundation on
feat/foundation-phase2. Queue/outbox work starts at T081; the production
membership store/deletion adapter remains a T076 follow-up boundary.

## Fresh database evidence

The gate used PostgreSQL 16 on loopback and two separately migrated databases:

- touchmyapi_t080_acceptance_test for integration tests;
- touchmyapi_t080_isolation_test for isolation tests.

The split is intentional. Integration fixtures are transactional but leave
catalog/account fixtures for their own assertions; the isolation project
requires an empty catalog and database-wide role checks. Both databases were
migrated from the current Drizzle journal before testing.

| Gate | Result |
| --- | ---: |
| Unit project | 275 passed / 15 files |
| Contract project | 36 passed / 10 files |
| Integration project | 68 passed / 6 files |
| Isolation project | 24 passed / 5 files |
| TypeScript strict check | passed |
| ESLint | passed |
| Prettier check | passed |
| Web production build | passed |
| git diff check | passed |
| Local smoke (dev:local + local:smoke) | API and web PASS |

## Acceptance evidence

- Every request resolves the active account from the server session and an
  active membership. Suspended/removed memberships fail closed.
- Roles are owner, admin, operator, viewer, and billing with default-deny
  capability checks. Multiple active owners are allowed; the last active owner
  cannot be demoted or removed by the transactional guard.
- Invitations persist only SHA-256 token hashes. Acceptance is an explicit JSON
  body action, redacted before access/app logs, generic on invalid/other-user
  input, single-use, and idempotent for the accepted user.
- Account listing and switching use fixed auth-bootstrap functions. Switching
  rotates the opaque session hash and invalidates the previous hash.
- The existing global user table remains the sole identity authority.
  Membership, session, assessment, and attestation isolation is covered by the
  24-test isolation project.
- The expand-contract review (T079) proves legacy user.account_id and its
  unique constraint remain present, owner/session backfill behavior works,
  dual-read switching works, and the orphan/no-email guard is explicit.
- GitHub/X remain model-disabled. Provider adapters and local development
  auth/membership stores are injectable; no provider or billing key is needed
  for the local flow.

## Local user flow

Start the reproducible local path:

    bun run dev:local

In a second terminal:

    bun run local:smoke

Open http://localhost:5173. The local development composition creates a
session with two accounts, lets the user switch accounts, and lists the active
membership. It does not deliver real invitations, execute assessments, or
contact external targets.

T080 is the evidence gate for the membership phase. T076 production adapter
and account-deletion implementation must be completed before claiming the
full lifecycle API is production-ready.
