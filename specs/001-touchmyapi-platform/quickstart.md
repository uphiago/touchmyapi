# Quickstart: TouchMyAPI Foundation

**Foundation validation** | **Updated**: 2026-08-24

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
- Dependency-injected Hono API boundary (T020) with exact CORS, request IDs, stable errors, audit gating, and no assessment routes in the default production composition
- OAuth Authorization Code + PKCE boundary (T021) with encrypted transient state, hash-only rotating sessions, revocation, secure cookies, and a fakeable provider adapter; the current customer composition is GitHub
- T071–T075 and T077–T080 multi-user foundation: additive memberships/invitations, role capability policy, active-account session list/switch, hash-only invitation acceptance, RLS acceptance, and server-driven workspace UI; T076 account deletion/data elimination remains open
- T081–T086 PostgreSQL queue/outbox infrastructure: transactional enqueue, fair fenced claims, lease recovery, reconciliation, and standalone outbox controls
- Development-only account-scoped assessment draft → queue routes and web panel, backed by PostgreSQL in the supported local composition; only persona/auth fixtures are local mocks
- T095 customer operations cockpit with Overview/Assessments/Team/Workspace navigation and guided authorization-first draft flow
- T096–T097 separate development-only admin API/UI on `3001/5174`, dedicated cookie/origin/store, grant-before-action simulation, and cross-session denial smoke
- T098–T099 non-root production images, private PostgreSQL Compose topology, migration-before-cutover, and SHA-pinned GitHub Actions → OVH release automation
- Provider-neutral GitHub OAuth + PKCE, first-owner workspace provisioning, persistent hash-only sessions, memberships, and account switching
- Real customer production composition with dedicated `auth_connector`, `api_connector`, and `audit_system_connector` preflight
- PostgreSQL-backed passive assessment draft/list/policy/queue and redacted transactional outbox intent
- Public landing plus role-aware owner/admin/operator/viewer/billing customer flows and plan-delivery guidance
- Connector credential configuration and four-origin public smoke in the OVH workflow
- Development worker-control with a deterministic fixture runner, bounded passive analysis, fenced terminal publication, completion notification, and no target network access
- Local private MinIO report storage with plan-filtered delivery: aggregate results for `free_unverified`, masked findings for `free_verified`, and sanitized technical PDF, executive PDF, and `report.json@1` objects for `pro`/`lifetime`

The local mode executes one deterministic passive fixture assessment end to end, including worker claim, analysis, terminal delivery, notification, and three private report objects. It never contacts an external target. Production persists passive draft/list/queue state, but the worker is under the `execution` profile, `RUNNER_MODE=fixture` is rejected in production, and the isolated runner adapter is unavailable; production worker execution and target contact therefore remain disabled under T106. Billing mutation, Stripe webhook entitlement, active HTTP verification, AI execution, and the private agent remain open. Production accepts `AUTH_PROVIDER=disabled` until a GitHub OAuth App exists, or `github` with explicit credentials; mocks remain forbidden.

The public web entrypoint is `https://touchmyapi.com`. It renders the landing
without requiring a session; `https://app.touchmyapi.com` is the customer console
host used after sign-in. `www.touchmyapi.com` canonicalizes to the apex. The same
web image serves both hosts, but the SPA keeps the apex permanently public so an
authenticated console session never changes the public marketing entrypoint.

The historical Foundation Phase 2 remains intentionally limited to T010–T021. The approved Phase 2A extension follows T021: T071–T075 and T077–T080 provide the additive membership foundation, RLS cut, server-driven workspace UI, and partial acceptance gate before the fenced PostgreSQL queue/outbox and separate admin control plane; T076 account deletion/data elimination is still open. SSO and SCIM remain out of scope; Google/X customer login is modeled-disabled and provider adapters remain injectable until production credentials are supplied.

## Prerequisites

- Bun 1.4.0
- Docker with Compose v2 for the Compose configuration check and optional local PostgreSQL test

If Docker is unavailable, complete all Bun checks locally and run the Compose command on a Docker-enabled development or CI machine. The absence of Docker does not justify skipping Compose validation before release.

## Environment

The checks require no OAuth, Stripe, or target credentials. Local delivery uses the Compose MinIO service with development-only credentials supplied by `dev:local`; production object-storage credentials are required only when the execution profile is explicitly enabled. Optional local overrides can be copied from the safe template:

```bash
cp .env.example .env
```

`.env` remains ignored. The Compose PostgreSQL port is `127.0.0.1:5433`; `DATABASE_URL` is intentionally blank in `.env.example` and must be set explicitly before migrations or an integration test. `VITE_API_BASE_URL` is public; do not place secrets in any `VITE_*` variable.

## Foundation verification

Run from the repository root, in order:

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

## Run the local stack with logs and smoke verification

The repository provides one reproducible local path. It starts loopback-only
PostgreSQL, applies migrations to the local `touchmyapi` database, then starts
the customer API/web and isolated admin API/web with inherited logs:

```bash
bun run dev:local
```

Development mode sets `LOCAL_MOCKS=1` only for the customer API and
`LOCAL_ADMIN_MOCKS=1` only for the admin API. The customer API exposes a local
demo session with five named owner/admin/operator/viewer/billing workspaces and
a five-role team roster, so navigation, server-enforced permissions, membership
screens, and assessment draft → queue panel are usable without OAuth
credentials. The admin mock uses its own CORS origin, cookie, and in-memory store. This composition is not used by production mode, does not persist or deliver real invitations, and does not contact targets.

In a second terminal, wait for both processes and run the smoke check:

```bash
bun run local:smoke
```

Expected output contains:

```text
[smoke] PASS worker readiness http://127.0.0.1:3002/ready
[smoke] PASS API health http://127.0.0.1:3000/health
[smoke] PASS admin API health http://127.0.0.1:3001/health
[smoke] PASS web shell http://127.0.0.1:5173
[smoke] PASS admin web shell http://127.0.0.1:5174
[smoke] PASS draft → queued → completed → detailed delivery → 3 private reports <account-id>
[smoke] PASS admin grant → distinct approval → bounded simulation
[smoke] local stack is responding
```

The completed T095–T100 checkpoint includes the separate development-only admin API and application at `http://127.0.0.1:3001` and `http://127.0.0.1:5174`. They use a dedicated admin cookie, CORS origin, and server-side mock store; customer sessions cannot authenticate to them and admin sessions cannot authenticate to customer routes. See
`docs/superpowers/specs/2026-08-23-user-admin-console-design.md` and
`docs/superpowers/plans/2026-08-23-user-admin-ovh-implementation.md`.

The API and Vite logs remain attached to the first terminal. To inspect the
PostgreSQL container independently, use `bun run local:logs`. Stop only the
application processes with `Ctrl-C`; stop the local container without deleting
its volume with `bun run local:down`.

The smoke check only contacts loopback services. It bootstraps both development sessions, proves cross-cookie denial, creates and queues one assessment, waits for the fixture worker to publish deterministic findings/notification/reports, performs one grant-gated simulated admin action, and never contacts an external target.

## Run the API and web shell manually

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

Open `http://localhost:5173`. The workspace reports `API online` only after validating the response against the shared Zod schema. Without an authenticated session it should show the server error state rather than inventing account data.

## PostgreSQL integration and isolation gates

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

Run those DB suites sequentially in the same PostgreSQL cluster and keep their databases separate. Catalog/auth tests intentionally inspect database-wide state and alter cluster-global connector credentials before restoring them. Tests refuse non-loopback hosts and database names without the `_test` suffix.

On a fresh PostgreSQL volume, the init scripts create the separate `touchmyapi_test` database. Init scripts run only during first volume initialization. For an existing volume, apply the idempotent init SQL safely without deleting data:

```bash
docker compose --profile local -f infra/docker/compose.yml exec -T postgres psql -U touchmyapi_dev -d postgres \
  < infra/docker/postgres/init/002_test_database.sql
```

The current DB package proves schema shape, runtime-role privileges, exact connector membership, auth-bootstrap isolation, cross-account RLS behavior, the closed tenant-capability boundary, and atomic audit writing with API/worker/system chain isolation. The provider/runtime, membership, queue, role-aware UI, local fixture delivery and private-report smoke gates are green. Account deletion, production worker execution/isolated runner, Stripe entitlement, and production staff MFA/JIT remain tracked explicitly in tasks.

## Next validation milestones

The local passive delivery scenario is runnable; the production delivery gate is not. Continue in the order defined by [tasks.md](./tasks.md):

1. Complete T106 production worker execution with an isolated runner, production private storage readiness, fenced publication, and the remaining acceptance evidence.
2. Complete T107 staff OIDC, WebAuthn MFA, persistent JIT approvals, and production admin queue functions.
3. Add webhook-only Stripe entitlement, active HTTP-file verification, SSRF-safe fetching, and the private agent in task order.

The multi-user extension is validated after T021 with these additional milestones:

4. The global immutable provider `user` identity, explicit `account_membership(account_id,user_id)`, token-hash invitations, role matrix, active-account session rotation, and membership RLS isolation (T071–T075, T077–T080; T076 deletion remains open).
5. Tenant enqueue uses closed typed `packages/db/src/queue.ts` under `api_rls`/`app.tenant` after membership/policy/entitlement checks; PostgreSQL worker queue control uses `packages/db/src/queue-control.ts` with `queue_connector` `EXECUTE` only, zero table grants, and no enqueue/admin functions. Claims use `SKIP LOCKED`, global→tenant→job ordering for every job/counter mutation, lease/fencing token, heartbeat, retry/backoff, exact fair scheduling, tenant/global limits, and transactional outbox. Standalone outbox uses `outbox_claim/heartbeat/ack/fail/reap` with deterministic outbox-only locks and never touches global/job rows; admin cancel/requeue/account-reaper use separate JIT-gated functions. `LISTEN/NOTIFY` is only a hint (T081–T087).
6. Separate admin app/API/origin, `staff_identity` and related staff tables, mandatory MFA, JIT reason/ticket/TTL/approval, dual break-glass, policy-aware queue operations, and read-only billing with no secrets/raw evidence/arbitrary SQL/impersonation (T088–T094).

The authoritative design references are the [constitution](../../.specify/memory/constitution.md), [data model](./data-model.md), [research](./research.md), and [contracts](./contracts/index.md). Drift from those documents is a bug; when they conflict, the constitution wins.
