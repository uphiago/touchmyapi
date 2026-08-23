# TouchMyAPI

TouchMyAPI is a platform for authorized security assessments. The executable foundation currently includes the Bun monorepo, shared Zod contracts, the pure default-deny policy engine (T010–T013), the PostgreSQL 16 domain schema (T014), least-privilege runtime roles with forced RLS and narrow auth bootstrap functions (T015), a Hono health endpoint, a React/Vite shell, and loopback-only local PostgreSQL infrastructure.

## Project status

T017 is now accepted: it adds recursive redaction, monotonic append-only tenant/system audit chains, per-account and system FORCE-RLS lock authorities, API/worker closed writers, and fixed-column insert privileges; specification and adversarial quality reviews passed. T018–T021 remain unimplemented. The multi-user, PostgreSQL queue/outbox, and separate admin control-plane work in T071–T094 is design-only and remains unchecked.

The authoritative handoff is the [foundation checkpoint](docs/reviews/2026-08-22-foundation-checkpoint.md). Status checkboxes live in [platform tasks](specs/001-touchmyapi-platform/tasks.md); architecture and operational decisions remain in the linked plan, spec, research, data model, contracts, and quickstart under `specs/001-touchmyapi-platform/`.

## Current security boundary

The foundation does **not** execute assessments or contact external targets. Google OAuth, durable queue/outbox, Stripe webhooks, sandboxed runners, reports, AI orchestration, and the private agent remain unimplemented. T016 exposes no raw PostgreSQL connection or generic query surface from `@touchmyapi/db`: callers receive an opaque connection handle and a frozen tenant context whose account capabilities are role-specific and expire at transaction completion. See the [checkpoint review](docs/reviews/2026-08-22-foundation-checkpoint.md) and [T016 review](docs/reviews/2026-08-22-t016-capability-boundary.md).

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
docker compose --profile local -f infra/docker/compose.yml config
```

The foundation plan records the older Bun spelling `bun --cwd apps/web run build`. Bun 1.4.0 uses `bun run --cwd apps/web build`, shown above. CI must run this full validation sequence (including the Compose config check) before accepting changes.

Expected results: workspace verification, unit/contract tests, TypeScript strict checking, lint/format checks, the web build, and Compose validation succeed. PostgreSQL integration/isolation suites are opt-in and are not counted as green when skipped. None of these commands starts an assessment or contacts an external target.

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

Start the API:

```bash
bun run dev:api
```

It listens on `http://localhost:3000`; `GET /health` returns `{"status":"ok"}`. In another terminal, the optional web shell runs with:

```bash
bun run dev:web
```

Open `http://localhost:5173`. The API allows this local origin only on the public health route; future authenticated routes require their own narrow security policy.

See the [foundation quickstart](specs/001-touchmyapi-platform/quickstart.md) for validation details and [platform tasks](specs/001-touchmyapi-platform/tasks.md) for the remaining phases.
