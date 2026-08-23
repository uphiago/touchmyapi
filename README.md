# TouchMyAPI

TouchMyAPI is a platform for authorized security assessments. The executable foundation currently includes the Bun monorepo, shared Zod contracts, the pure default-deny policy engine (T010–T013), the PostgreSQL 16 domain schema (T014), least-privilege runtime roles with forced RLS and narrow auth bootstrap functions (T015), a Hono health endpoint, a React/Vite shell, and loopback-only local PostgreSQL infrastructure.

## Project status

T020 and T021 are accepted, and the T071–T075 plus T077 multi-user membership foundation is implemented on the phase-2 branch. T020 adds the dependency-injected Hono API boundary with exact CORS, server-owned request IDs, pre-handler redaction-safe audit gating, stable error envelopes, and fail-closed audit configuration. T021 adds a Google-only, fakeable OAuth Authorization Code + PKCE boundary with encrypted transient state, hash-only sessions, rotation, revocation, and secure cookies. The membership slice adds additive account memberships/invitations, role capabilities, session-bound account list/switch, body-only invitation acceptance, the T076 lifecycle API boundary, and two-account RLS/composite-FK enforcement. The production membership store/account-deletion workflow, browser UI, PostgreSQL queue/outbox, and separate admin control-plane work in T076 and T078–T094 are still pending.

The authoritative handoff is the [foundation checkpoint](docs/reviews/2026-08-22-foundation-checkpoint.md). Status checkboxes live in [platform tasks](specs/001-touchmyapi-platform/tasks.md); architecture and operational decisions remain in the linked plan, spec, research, data model, contracts, and quickstart under `specs/001-touchmyapi-platform/`.

## Current security boundary

The foundation does **not** execute assessments or contact external targets. Durable queue/outbox, Stripe webhooks, sandboxed runners, reports, AI orchestration, and the private agent remain unimplemented. T021's real Google adapter is an explicit composition boundary; tests inject a fake adapter and never contact Google. GitHub/X remain model-disabled. T016 exposes no raw PostgreSQL connection or generic query surface from `@touchmyapi/db`: callers receive an opaque connection handle and a frozen tenant context whose account capabilities are role-specific and expire at transaction completion. T018's secrets package is an isolated crypto boundary with no environment lookup, persistence, logging, or runtime dependencies. T019 is contract-only and does not perform DNS/HTTP/TLS or any other network operation. T020 is an API boundary only; its executable default audit sink fails closed and no assessment handler exists. See the [membership foundation review](docs/reviews/2026-08-23-multiuser-membership-foundation.md) and the earlier [checkpoint review](docs/reviews/2026-08-22-foundation-checkpoint.md) for the current boundaries.

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
