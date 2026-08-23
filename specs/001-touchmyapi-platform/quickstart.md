# Quickstart: TouchMyAPI Foundation

**Foundation validation** | **Updated**: 2026-08-22

This guide validates the code that exists today. It does not claim that the full platform scenarios in the [product spec](./spec.md) are implemented.

## Implemented scope

- Bun workspace with TypeScript strict mode
- Shared Zod contracts for assessment, playbook, job, artifact, export, billing, audit, health, errors, and redaction shapes
- Pure policy package: scope normalization/blocklists, entitlement rights, non-escalating limits, and default-deny authorization (T010–T013)
- Hono `GET /health` API with a JSON 404 envelope
- React/Vite shell that validates the health response
- PostgreSQL foundation schema/migrations, composite tenant references, session hashes/families, and exact enum/check/default constraints (T014)
- `api_rls`, `worker_rls`, and `reporting_rls` least-privilege roles, forced default-deny RLS, and fixed-purpose auth bootstrap functions (T015)
- Explicit PostgreSQL connection factory and opt-in integration/isolation suites
- PostgreSQL 16 Compose service bound to loopback only
- Context-bound `@touchmyapi/secrets` AES-256-GCM envelope for external credentials (T018), with versioned key-ID AAD, bounded inputs, generic failures, and no env/log/persistence access
- Strict passive `@touchmyapi/playbooks` catalog `surface-public-posture@1.0.0` (T019), aligned with the policy engine and containing no execution/network behavior

No assessment execution, external target access, Google authentication routes, queue, billing mutation, AI execution, report generation, or runner exists in this checkpoint. T016 and T017 are accepted: the tenant wrapper is an opaque database handle with fixed capabilities, and the audit writer provides redacted monotonic tenant/system chains with FORCE-RLS lock authorities and no raw SQL export. T018 is accepted as the isolated external-credential AEAD boundary, and T019 as the passive catalog boundary; T020–T021 remain pending.

The historical Foundation Phase 2 remains intentionally limited to T010–T021 and does not implement organizations, invitations, roles, or admin operations. The approved Phase 2A extension is documented separately and is scheduled after T021: account/workspace membership first, then the fenced PostgreSQL queue/outbox, followed by the separate admin control plane. SSO and SCIM remain out of scope.

## Prerequisites

- Bun 1.4.0
- Docker with Compose v2 for the Compose configuration check and optional local PostgreSQL test

If Docker is unavailable, complete all Bun checks locally and run the Compose command on a Docker-enabled development or CI machine. The absence of Docker does not justify skipping Compose validation before release.

## Environment

The checks require no OAuth, Stripe, object-storage, or target credentials. Optional local overrides can be copied from the safe template:

```bash
cp .env.example .env
```

`.env` remains ignored. The Compose PostgreSQL port is `127.0.0.1:5433`; `DATABASE_URL` is intentionally blank in `.env.example` and must be set explicitly before migrations or an integration test. `VITE_API_BASE_URL` is public; do not place secrets in any `VITE_*` variable.

## Foundation verification

Run from the repository root, in order:

```bash
bun install
bun run verify:workspace
bun test
bun run typecheck
bun run --cwd apps/web build
docker compose --profile local -f infra/docker/compose.yml config
```

The foundation implementation plan used `bun --cwd apps/web run build`. With Bun 1.4.0, use the equivalent `bun run --cwd apps/web build` shown in the runnable sequence. CI must run this complete validation sequence, including the Compose config check, before accepting changes.

Database migrations require an explicit `DATABASE_URL`; there is no application fallback:

```bash
DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@localhost:5433/touchmyapi \
  bun run db:migrate
```

Expected:

- workspace manifests are present;
- policy, contract, API, and DB-boundary unit tests pass;
- live DB integration/isolation tests are skipped unless `RUN_DB_TESTS=1` and must not be reported as green when skipped;
- TypeScript strict checking exits successfully;
- Vite creates ignored files under `apps/web/dist`;
- Compose resolves a PostgreSQL 16 service exposed only on `127.0.0.1:5433`.

No command above starts an assessment or contacts an external target.

## Run the API and web shell

Start the API:

```bash
bun run dev:api
```

Check `http://localhost:3000/health`; the response is:

```json
{"status":"ok"}
```

Optionally start the web shell in another terminal:

```bash
bun run dev:web
```

Open `http://localhost:5173`. The shell reports `API online` only after validating the response against the shared Zod schema.

## PostgreSQL integration and isolation gates

```bash
docker compose --profile local -f infra/docker/compose.yml up -d postgres
DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test \
  bun run db:migrate
RUN_DB_TESTS=1 \
  DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test \
  bun run test:integration --maxWorkers=1
RUN_DB_TESTS=1 \
  DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test \
  bun run test:isolation --maxWorkers=1
```

Run those DB suites sequentially against a given database. Parallel processes need separately migrated `_test` databases because catalog/auth tests intentionally assert database-wide state. Tests refuse non-loopback hosts and database names without the `_test` suffix.

On a fresh PostgreSQL volume, the init scripts create the separate `touchmyapi_test` database. Init scripts run only during first volume initialization. For an existing volume, apply the idempotent init SQL safely without deleting data:

```bash
docker compose --profile local -f infra/docker/compose.yml exec -T postgres psql -U touchmyapi_dev -d postgres \
  < infra/docker/postgres/init/002_test_database.sql
```

The current DB package proves schema shape, runtime-role privileges, auth-bootstrap isolation, cross-account RLS behavior, T016's closed tenant-capability boundary, and T017's atomic audit writer with API/worker/system chain isolation. T018's focused AEAD suite and T019's catalog→policy authorization suite are also green; T020–T021 remain before the database/API foundation gate is accepted.

## Next validation milestones

The end-to-end scenarios formerly listed here are not runnable yet. Implement them in the order defined by [tasks.md](./tasks.md):

1. Implement the Hono security boundary and Google OAuth sessions (T020–T021).
4. Only then implement membership and the PostgreSQL queue/outbox before assessment state/UI work.
5. Add webhook-only Stripe entitlement, HTTP-file verification, SSRF-safe fetching, sandboxed execution, evidence/reports, and the private agent in task order.

The multi-user extension is validated after T021 with these additional milestones:

7. The existing global Google `user` identity, explicit `account_membership(account_id,user_id)`, token-hash invitations, role matrix, active-account session rotation, and membership RLS isolation (T071–T080).
8. Tenant enqueue uses closed typed `packages/db/src/queue.ts` under `api_rls`/`app.tenant` after membership/policy/entitlement checks; PostgreSQL worker queue control uses `packages/db/src/queue-control.ts` with `queue_connector` `EXECUTE` only, zero table grants, and no enqueue/admin functions. Claims use `SKIP LOCKED`, global→tenant→job ordering for every job/counter mutation, lease/fencing token, heartbeat, retry/backoff, exact fair scheduling, tenant/global limits, and transactional outbox. Standalone outbox uses `outbox_claim/heartbeat/ack/fail/reap` with deterministic outbox-only locks and never touches global/job rows; admin cancel/requeue/account-reaper use separate JIT-gated functions. `LISTEN/NOTIFY` is only a hint (T081–T087).
9. Separate admin app/API/origin, `staff_identity` and related staff tables, mandatory MFA, JIT reason/ticket/TTL/approval, dual break-glass, policy-aware queue operations, and read-only billing with no secrets/raw evidence/arbitrary SQL/impersonation (T088–T094).

The authoritative design references are the [constitution](../../.specify/memory/constitution.md), [data model](./data-model.md), [research](./research.md), and [contracts](./contracts/index.md). Drift from those documents is a bug; when they conflict, the constitution wins.
