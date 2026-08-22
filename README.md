# TouchMyAPI

TouchMyAPI is a platform for authorized security assessments. This repository is currently the executable foundation scaffold: a Bun monorepo, shared Zod contracts, a Hono health endpoint, a React/Vite shell, a PostgreSQL connection boundary, and loopback-only local PostgreSQL Compose infrastructure.

## Current security boundary

The scaffold does **not** execute assessments or contact external targets. Authentication, PostgreSQL RLS, the policy engine, durable queue, Stripe webhooks, sandboxed runners, reports, AI orchestration, and the private agent are future phases. No scanner or active route may be added before the authorization, isolation, and policy controls required by the [constitution](.specify/memory/constitution.md) are implemented and tested.

## Prerequisites

- Bun 1.x
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
docker compose -f infra/docker/compose.yml config
```

The foundation plan records the older Bun spelling `bun --cwd apps/web run build`. Bun 1.4 uses `bun run --cwd apps/web build`, shown above; both invoke the `build` script in `apps/web` on Bun versions that support the respective spelling.

Expected results: workspace verification succeeds, four or more unit tests pass, the PostgreSQL integration test is skipped unless explicitly enabled, TypeScript strict checking succeeds, Vite writes ignored output to `apps/web/dist`, and Compose reports a valid configuration. None of these commands starts an assessment or contacts an external target.

## Environment

The foundation runs without third-party credentials. To override local defaults:

```bash
cp .env.example .env
```

`.env` is ignored by Git. Never commit OAuth credentials, Stripe keys, database passwords, target credentials, tokens, or other secrets. Variables prefixed with `VITE_` are public by definition.

The Compose service binds PostgreSQL to `127.0.0.1:5433`. Start it, then optionally run the database smoke test:

```bash
docker compose -f infra/docker/compose.yml up -d postgres
RUN_DB_TESTS=1 bun test packages/db/test/connection.test.ts
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
