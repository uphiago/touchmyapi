# TouchMyAPI

TouchMyAPI is a multi-user platform for authorized security assessments. Its current executable slice includes GitHub OAuth with PKCE, server-selected workspaces and five roles, forced-RLS PostgreSQL persistence, policy-gated passive assessment draft → durable queue, a customer console, a separate local staff console, and immutable GitHub Actions → OVH releases.

## Project status

The current branch adds provider-neutral GitHub identity provisioning, persistent sessions/memberships/assessments, a dedicated `api_connector`, role-aware customer journeys, plan-delivery guidance, and a useful but explicitly local staff workflow. Queue/outbox primitives are durable. Worker execution, completed findings/reports, Stripe webhook entitlement, active HTTP verification, the private agent, and persistent staff OIDC/WebAuthn/JIT remain open in [platform tasks](specs/001-touchmyapi-platform/tasks.md).

The authoritative handoff is the [foundation checkpoint](docs/reviews/2026-08-22-foundation-checkpoint.md). Status checkboxes live in [platform tasks](specs/001-touchmyapi-platform/tasks.md); architecture and operational decisions remain in the linked plan, spec, research, data model, contracts, and quickstart under `specs/001-touchmyapi-platform/`.

## Current security boundary

The platform does **not yet execute or contact targets**. Production can persist an authorized passive draft and queue intent, but no worker claims it. Customer/staff mocks require explicit development flags and are hard-disabled in production. Production may run with `AUTH_PROVIDER=disabled` while the GitHub OAuth App is absent; the landing then shows an honest setup state. Production admin remains unavailable until T088–T094.

The canonical persona, navigation, assessment and result rules are in [product journeys](docs/product/user-journeys.md). Deployment and rollback are in the [OVH runbook](docs/operations/ovh-deployment.md).

For a local end-to-end smoke run, use `bun run dev:local`. It starts PostgreSQL, migrations, customer API/web on `127.0.0.1:3000/5173`, and admin API/web on `127.0.0.1:3001/5174`, all with attached logs. Run `bun run local:smoke` in another terminal. `bun run local:logs` tails PostgreSQL and `bun run local:down` stops local Compose services without deleting volumes.

The local session exposes named owner, admin, operator, viewer and billing workspaces. The smoke validates browser CORS/credentials, customer draft → queued, cross-cookie rejection, and admin grant → distinct approval → bounded simulation. It never contacts an external target or performs a real queue action.

## Prerequisites

- Bun 1.4.0
- Docker with Compose v2 for validating or running local PostgreSQL

Docker is not needed for the unit tests or web build. If Docker is unavailable on a worker, run the Compose validation below on a development machine or CI runner that has Docker; `config` validates the file without starting containers.

## Install and verify

From the repository root:

```bash
bun install
bun run verify:workspace
bun test
bun run typecheck
bun run --cwd apps/web build
bun run --cwd apps/admin build
docker compose --profile local -f infra/docker/compose.yml config
bun scripts/validate-production-compose.ts
```

The foundation plan records the older Bun spelling `bun --cwd apps/web run build`. Bun 1.4.0 uses `bun run --cwd apps/web build`, shown above. CI must run this full validation sequence (including the Compose config check) before accepting changes.

Expected results: workspace verification, unit/contract tests, TypeScript strict checking, lint/format checks, customer/admin builds, and both Compose validations succeed. PostgreSQL integration/isolation suites are opt-in and are not counted as green when skipped. None of these commands starts an assessment or contacts an external target.

## Environment

The foundation runs without third-party credentials. To override local defaults:

```bash
cp .env.example .env
```

`.env` is ignored by Git. Never commit OAuth credentials, Stripe keys, database passwords, target credentials, tokens, or other secrets. Variables prefixed with `VITE_` are public by definition. The template leaves `DATABASE_URL` and real credentials empty; set `DATABASE_URL` in the shell or `.env` before running migrations.

Database migrations require an explicit URL and fail closed when it is absent:

```bash
DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@localhost:5433/touchmyapi bun run db:migrate
```

The Compose service binds PostgreSQL to `127.0.0.1:5433`. Start it, migrate a dedicated `_test` database, then run database gates sequentially:

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

Do not run DB suites concurrently against the same database: some catalog/auth fixtures intentionally inspect database-wide state. Give each parallel process its own migrated `_test` database.

The fresh-volume init scripts create both `touchmyapi` and `touchmyapi_test`; the test database is created only when PostgreSQL initializes a new volume. For an existing volume, the idempotent init SQL can be applied safely without deleting data:

```bash
docker compose --profile local -f infra/docker/compose.yml exec -T postgres psql -U touchmyapi_dev -d postgres \
  < infra/docker/postgres/init/002_test_database.sql
```

## Run locally

For the complete experience use `bun run dev:local`. To run customer processes manually, start the API:

```bash
bun run dev:api
```

It listens on `http://localhost:3000`; `GET /health` returns `{"status":"ok"}`. In another terminal, the optional web shell runs with:

```bash
bun run dev:web
```

Open `http://localhost:5173`. The API allows this local origin only on the public health route; future authenticated routes require their own narrow security policy.

Manual admin commands are `bun run dev:admin-api` and `bun run dev:admin`; the development mock additionally requires the environment configured by `dev:local`, so the combined command is the supported credential-free path.

See the [foundation quickstart](specs/001-touchmyapi-platform/quickstart.md) for validation details and [platform tasks](specs/001-touchmyapi-platform/tasks.md) for the remaining phases.
