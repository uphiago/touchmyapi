# TouchMyAPI

TouchMyAPI is a multi-user platform for authorized security assessments. Its current executable slice includes GitHub OAuth with PKCE, server-selected workspaces and five roles, forced-RLS PostgreSQL persistence, policy-gated passive assessment draft → durable queue, a customer console, a separate local staff console, and immutable GitHub Actions → OVH releases.

## Project status

The current branch adds provider-neutral GitHub identity provisioning, persistent sessions/memberships/assessments, a dedicated `api_connector`, role-aware customer journeys, plan-delivery guidance, a local passive worker fixture, deterministic findings, completion notifications, and private JSON/PDF report publication for eligible plans. Queue/outbox primitives are durable. Production worker execution, Stripe webhook entitlement, active HTTP verification, the private agent, and persistent staff OIDC/WebAuthn/JIT remain open in [platform tasks](specs/001-touchmyapi-platform/tasks.md).

The authoritative handoff is the [foundation checkpoint](docs/reviews/2026-08-22-foundation-checkpoint.md). Status checkboxes live in [platform tasks](specs/001-touchmyapi-platform/tasks.md); architecture and operational decisions remain in the linked plan, spec, research, data model, contracts, and quickstart under `specs/001-touchmyapi-platform/`.

## Current security boundary

The local stack executes a deterministic passive fixture after a queued assessment, publishes plan-filtered findings and a completion notification, and stores three private report objects for `pro`/`lifetime` plans. The fixture never contacts a target. Production can persist an authorized passive draft and queue intent, but the worker profile is disabled by default and the isolated runner adapter is not available; production therefore does not execute or contact targets. Customer/staff mocks require explicit development flags and are hard-disabled in production. Production may run with `AUTH_PROVIDER=disabled` while the GitHub OAuth App is absent; the landing then shows an honest setup state. Production admin remains unavailable until T088–T094.

## Personas and plan delivery

Membership is server-authoritative. Owners and admins manage team membership; operators create and queue authorized assessments; viewers read permitted results; billing users read billing state and may initiate a future purchase intent. Staff use a separate admin origin and remain unable to impersonate customers, access secrets/raw evidence, or write billing state.

Plan rights reduce delivery at the API boundary and are never decided by the browser:

| Plan               | Findings                                                  | Reports                                                   |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------- |
| `free_unverified`  | Aggregate totals only                                     | Not available                                             |
| `free_verified`    | Title, category, severity                                 | Not available                                             |
| `pro` / `lifetime` | Redacted evidence, safe reproduction, impact, remediation | Private technical PDF, executive PDF, and `report.json@1` |

The local fixture demonstrates the complete queue → analysis → notification → private-report path. It is a development/test capability, not a production execution substitute.

The canonical persona, navigation, assessment and result rules are in [product journeys](docs/product/user-journeys.md). Deployment and rollback are in the [OVH runbook](docs/operations/ovh-deployment.md).

For a local end-to-end smoke run, use `bun run dev:local`. It starts PostgreSQL, migrations, customer API/web on `127.0.0.1:3000/5173`, and admin API/web on `127.0.0.1:3001/5174`, all with attached logs. Run `bun run local:smoke` in another terminal. `bun run local:logs` tails PostgreSQL and `bun run local:down` stops local Compose services without deleting volumes.

The local session exposes named owner, admin, operator, viewer and billing workspaces. The smoke validates browser CORS/credentials, a real PostgreSQL draft → queue → worker → delivery cycle, private report downloads, cross-cookie rejection, and admin grant → distinct approval → bounded simulation. It never contacts an external target.

## Prerequisites

- Bun 1.4.0
- Docker with Compose v2 for validating or running local PostgreSQL

Docker is not needed for the unit tests or web build. If Docker is unavailable on a worker, run the Compose validation below on a development machine or CI runner that has Docker; `config` validates the file without starting containers.

## Install and verify

From the repository root:

```bash
bun install
bun run verify:workspace
bun run test
bun run typecheck
bun run --cwd apps/web build
bun run --cwd apps/admin build
docker compose --profile local -f infra/docker/compose.yml config
bun scripts/validate-production-compose.ts
```

The foundation plan records the older Bun spelling `bun --cwd apps/web run build`. Bun 1.4.0 uses `bun run --cwd apps/web build`, shown above. CI must run this full validation sequence (including the Compose config check) before accepting changes.

Expected results: workspace verification, unit/contract tests, TypeScript strict checking, lint/format checks, customer/admin builds, and both Compose validations succeed. PostgreSQL integration/isolation suites are opt-in and are not counted as green when skipped. The local delivery smoke is the command that starts a fixture assessment; the validation sequence above does not start an assessment or contact an external target.

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

The Compose service binds PostgreSQL to `127.0.0.1:5433`. Start it and create two dedicated databases once; integration and isolation fixtures intentionally inspect database-wide state, so each suite needs its own clean boundary:

```bash
docker compose --profile local -f infra/docker/compose.yml up -d postgres
docker compose --profile local -f infra/docker/compose.yml exec -T postgres \
  createdb -U touchmyapi_dev touchmyapi_integration_test
docker compose --profile local -f infra/docker/compose.yml exec -T postgres \
  createdb -U touchmyapi_dev touchmyapi_isolation_test
DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_integration_test \
  bun run db:migrate
DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_isolation_test \
  bun run db:migrate
RUN_DB_TESTS=1 \
  DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_integration_test \
  bun run test:integration --maxWorkers=1
RUN_DB_TESTS=1 \
  DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_isolation_test \
  bun run test:isolation --maxWorkers=1
```

Choose unused names on first creation, or reuse a clean pair. Do not run DB suites against the same database or concurrently in the same PostgreSQL cluster: some fixtures intentionally alter cluster-global connector credentials while proving the least-privilege boundary.

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

Open `http://localhost:5173`. The local API admits only the configured customer origin with credentialed CORS; the separate admin origin and cookie cannot authenticate to customer routes.

Manual admin commands are `bun run dev:admin-api` and `bun run dev:admin`; the development mock additionally requires the environment configured by `dev:local`, so the combined command is the supported credential-free path.

See the [foundation quickstart](specs/001-touchmyapi-platform/quickstart.md) for validation details and [platform tasks](specs/001-touchmyapi-platform/tasks.md) for the remaining phases.
