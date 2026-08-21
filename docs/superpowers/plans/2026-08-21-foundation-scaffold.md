# TouchMyAPI Foundation Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Criar o primeiro incremento executável do TouchMyAPI: monorepo Bun, API com health check, web Vite, PostgreSQL local e contratos compartilhados, sem ainda executar assessments.

**Architecture:** O frontend Vite chama a API Bun por HTTP; a API e os próximos workers reutilizam contratos TypeScript compartilhados. PostgreSQL roda localmente via Docker Compose, mas nenhuma credencial ou regra de entitlement fica no browser. Os limites de segurança serão adicionados antes do primeiro runner.

**Tech Stack:** Bun 1.x, TypeScript strict, Vite, React, Hono, Zod, PostgreSQL 16, Docker Compose, Vitest.

---

### Task 1: Bootstrap workspace and shared TypeScript configuration

**Files:**
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.json`
- Create: `packages/tsconfig/base.json`
- Create: `.env.example`
- Test: `scripts/verify-workspace.ts`

- [ ] **Step 1: Write the workspace verification test**

Create `scripts/verify-workspace.ts`:

```ts
import { existsSync } from "node:fs";

const required = [
  "apps/api/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
  "packages/db/package.json",
  "tsconfig.json",
];

const missing = required.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`Missing workspace files: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("workspace files present");
```

- [ ] **Step 2: Add the root workspace manifests**

`package.json` must define Bun workspaces and scripts for `dev:api`, `dev:web`, `typecheck`, `test`, and `verify:workspace`. The root must not contain a Stripe secret or database password.

```json
{
  "name": "touchmyapi",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev:api": "bun --cwd apps/api dev",
    "dev:web": "bun --cwd apps/web dev",
    "typecheck": "bunx tsc --noEmit",
    "test": "bun test",
    "verify:workspace": "bun scripts/verify-workspace.ts"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

`tsconfig.json` extends `packages/tsconfig/base.json`, includes `apps` and `packages`, enables strict mode and `noUncheckedIndexedAccess`, and excludes `node_modules` and build output.

- [ ] **Step 3: Run the verification command**

Run: `bun scripts/verify-workspace.ts`

Expected: FAIL because the app/package manifests do not exist yet.

- [ ] **Step 4: Commit the workspace configuration**

Run: `git add package.json bunfig.toml tsconfig.json packages/tsconfig/base.json .env.example scripts/verify-workspace.ts && git commit -m "chore: bootstrap bun workspace"`

### Task 2: Add shared contracts package

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/assessment.ts`
- Create: `packages/contracts/src/http.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/assessment.test.ts`

- [ ] **Step 1: Write failing state contract tests**

`packages/contracts/test/assessment.test.ts` must assert that `draft`, `awaiting_verification`, `queued`, `running`, `analyzing`, `completed`, `failed`, and `cancelled` are valid states and that an unknown state is rejected.

```ts
import { describe, expect, it } from "vitest";
import { assessmentStateSchema } from "../src/assessment";

describe("assessment state contract", () => {
  it("accepts every persisted state", () => {
    for (const state of ["draft", "awaiting_verification", "queued", "running", "analyzing", "completed", "failed", "cancelled"]) {
      expect(assessmentStateSchema.parse(state)).toBe(state);
    }
  });

  it("rejects unknown states", () => {
    expect(() => assessmentStateSchema.parse("executing")).toThrow();
  });
});
```

- [ ] **Step 2: Implement the minimal Zod contracts**

Define `assessmentStateSchema`, `targetCategorySchema`, `healthResponseSchema`, and `errorResponseSchema` in focused files. Export their inferred TypeScript types from `src/index.ts`. Keep secrets, credentials, and raw runner output absent from these public HTTP contracts.

- [ ] **Step 3: Run the contract test**

Run: `bun test packages/contracts/test/assessment.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit the contracts**

Run: `git add packages/contracts && git commit -m "feat: add shared domain contracts"`

### Task 3: Create the Bun API health endpoint

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/test/health.test.ts`

- [ ] **Step 1: Write the failing API test**

The test imports the app without opening a real port and asserts `GET /health` returns status 200 and `{ "status": "ok" }`.

```ts
import { describe, expect, it } from "vitest";
import { app } from "../src/app";

describe("GET /health", () => {
  it("returns service health without authentication", async () => {
    const response = await app.request("http://localhost/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 2: Implement the Hono app**

Create `app` with only `GET /health` and a JSON 404 response. `server.ts` reads `PORT` from `process.env` with `3000` as the development default and starts `Bun.serve({ port, fetch: app.fetch })`. Do not add OAuth, Stripe, database credentials, or runner routes in this task.

- [ ] **Step 3: Run the API test**

Run: `bun test apps/api/test/health.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit the API slice**

Run: `git add apps/api && git commit -m "feat: add bun api health endpoint"`

### Task 4: Create the Vite web shell

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/app.css`
- Create: `apps/web/vite.config.ts`

- [ ] **Step 1: Add the web package and entrypoint**

Create a React Vite app that renders a neutral loading shell with the product name and a link target for `/health`. The shell must not display plan rights, secrets, or fake assessment data.

- [ ] **Step 2: Add the API health client**

Use `VITE_API_BASE_URL` only as a public URL. The client calls `/health` from a user action or initial status check and displays `API online` only when the response validates against `healthResponseSchema`; otherwise display `API indisponível` without exposing response internals.

- [ ] **Step 3: Run the web typecheck/build**

Run: `bun --cwd apps/web run build`

Expected: Vite produces `apps/web/dist` without warnings about missing entrypoints.

- [ ] **Step 4: Commit the web shell**

Run: `git add apps/web && git commit -m "feat: add vite web shell"`

### Task 5: Add PostgreSQL local infrastructure and DB package boundary

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/src/index.ts`
- Create: `infra/docker/compose.yml`
- Create: `infra/docker/postgres/init/001_extensions.sql`
- Create: `packages/db/test/connection.test.ts`

- [ ] **Step 1: Add local PostgreSQL compose service**

The compose file runs PostgreSQL 16 on a non-public local port, uses `POSTGRES_DB=touchmyapi`, `POSTGRES_USER=touchmyapi_dev`, and reads the development password from a compose-local variable with a documented default only for local development. It must not use the Stripe `.env` values or expose PostgreSQL to all network interfaces.

- [ ] **Step 2: Add the DB package boundary**

`packages/db/src/index.ts` exports a connection factory that receives `DATABASE_URL` explicitly. It must throw a clear configuration error when the URL is absent and must not connect during module import. The first migration is intentionally not added until the RLS schema task is implemented.

- [ ] **Step 3: Add the connection smoke test**

The test is skipped unless `RUN_DB_TESTS=1`; when enabled it connects, runs `select 1 as ok`, and closes the pool in `afterAll`. This keeps unit tests deterministic while documenting the local integration check.

- [ ] **Step 4: Run the local infrastructure checks**

Run: `docker compose -f infra/docker/compose.yml config`

Expected: Compose configuration validates successfully.

Run: `bun test packages/db/test/connection.test.ts`

Expected: PASS with the integration test skipped when `RUN_DB_TESTS` is unset.

- [ ] **Step 5: Commit the database boundary**

Run: `git add packages/db infra/docker && git commit -m "chore: add local postgres infrastructure"`

### Task 6: Verify the complete foundation and update the quickstart

**Files:**
- Modify: `README.md`
- Modify: `specs/001-touchmyapi-platform/quickstart.md`
- Modify: `.env.example`

- [ ] **Step 1: Add the documented local commands**

Document the exact sequence: `bun install`, `bun run verify:workspace`, `bun test`, `bun --cwd apps/web run build`, `docker compose -f infra/docker/compose.yml config`, and `bun run dev:api`.

- [ ] **Step 2: Run the full foundation verification**

Run:

```bash
bun install
bun run verify:workspace
bun test
bun --cwd apps/web run build
docker compose -f infra/docker/compose.yml config
```

Expected: all commands exit 0; `.env` remains ignored; no test starts an assessment or contacts an external target.

- [ ] **Step 3: Commit and push the foundation plan documentation**

Run: `git add README.md specs/001-touchmyapi-platform/quickstart.md .env.example && git commit -m "docs: document foundation quickstart"`

Run: `git push origin main`

## Coverage review

This increment covers only the executable foundation. Google OAuth, PostgreSQL RLS, the assessment state machine, durable queue, policy engine, Stripe webhooks, runner isolation, reports, AI orchestration and the private agent remain separate implementation increments in `specs/001-touchmyapi-platform/tasks.md`. No scanner or active target interaction is permitted until those controls are implemented and tested.

