# Quickstart: TouchMyAPI Foundation

**Foundation validation** | **Updated**: 2026-08-22

This guide validates the code that exists today. It does not claim that the full platform scenarios in the [product spec](./spec.md) are implemented.

## Implemented scope

- Bun workspace with TypeScript strict mode
- Shared Zod contracts for assessment states, target categories, health, and errors
- Hono `GET /health` API with a JSON 404 envelope
- React/Vite shell that validates the health response
- Explicit PostgreSQL connection factory with an opt-in integration smoke test
- PostgreSQL 16 Compose service bound to loopback only

No assessment execution, external target access, authentication, RLS schema, queue, billing mutation, AI execution, or runner exists in this foundation.

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
- contract, API, and DB boundary unit tests pass;
- the live DB smoke test is skipped unless `RUN_DB_TESTS=1`;
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

## Optional PostgreSQL integration smoke test

```bash
docker compose --profile local -f infra/docker/compose.yml up -d postgres
DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@localhost:5433/touchmyapi_test \
  RUN_DB_TESTS=1 bun test packages/db/test/connection.integration.test.ts
```

On a fresh PostgreSQL volume, the init scripts create the separate `touchmyapi_test` database. Init scripts run only during first volume initialization. For an existing volume, apply the idempotent init SQL safely without deleting data:

```bash
docker compose --profile local -f infra/docker/compose.yml exec -T postgres psql -U touchmyapi_dev -d postgres \
  < infra/docker/postgres/init/002_test_database.sql
```

The current DB package only proves an explicit connection boundary. Schema migrations, runtime roles, tenant transaction setup, default-deny RLS policies, and cross-account isolation tests remain blocking work before user data is stored.

## Next validation milestones

The end-to-end scenarios formerly listed here are not runnable yet. Implement them in the order defined by [tasks.md](./tasks.md):

1. Google OAuth sessions, schema migrations, runtime roles, and RLS isolation tests.
2. Assessment state machine, policy engine, durable PostgreSQL queue, and passive visualization.
3. Webhook-only Stripe entitlement and server-side catalog gating.
4. HTTP-file verification and SSRF-safe fetching before any active external assessment.
5. Least-privilege sandbox runner, redacted evidence, private reports, and signed downloads.
6. AI as a non-executor and, later, the outbound-only private agent.

The multi-user extension is validated after T021 with these additional milestones:

7. Global Google identity separated from explicit account membership, token-hash invitations, role matrix, active-account session rotation, and membership RLS isolation (T071–T086).
8. PostgreSQL `SKIP LOCKED` claim, lease/fencing token, heartbeat, retry/backoff, reaper, fair scheduling, tenant/global limits, and transactional outbox; `LISTEN/NOTIFY` is only a hint (T087–T092).
9. Separate admin app/API/origin, staff identity, mandatory MFA, JIT reason/ticket/TTL/approval, dual break-glass, policy-aware queue operations, and read-only billing with no secrets/raw evidence/arbitrary SQL/impersonation (T093–T094).

The authoritative design references are the [constitution](../../.specify/memory/constitution.md), [data model](./data-model.md), [research](./research.md), and [contracts](./contracts/index.md). Drift from those documents is a bug; when they conflict, the constitution wins.
