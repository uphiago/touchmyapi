# GitHub Workspace V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver GitHub OAuth, atomic PostgreSQL workspace provisioning, persistent customer workspace routes, a credential-free local flow, and a production deployment that renders a usable sign-in experience.

**Architecture:** Generalize the existing OAuth boundary behind a provider-neutral adapter while preserving encrypted transient state, PKCE, hash-only rotating sessions, explicit memberships, forced RLS, and atomic audit. PostgreSQL capabilities live in `@touchmyapi/db`; the API composition root wires least-privilege auth, tenant, and audit connectors; React resolves session before loading tenant data and renders signed-out, loading, error, and workspace states honestly.

**Tech Stack:** Bun 1.4, TypeScript, Hono, React/Vite, Zod, PostgreSQL 16, postgres.js, Drizzle migrations, Vitest, Docker Compose, GitHub Actions, OVH/Caddy.

---

### Task 1: Provider-neutral public contracts and configuration

**Files:**

- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/test/auth.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `tests/contract/foundation-config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing contract and configuration tests**

```ts
expect(authProvidersResponseSchema.parse({ providers: [{ id: "github", label: "GitHub" }] }))
  .toEqual({ providers: [{ id: "github", label: "GitHub" }] });
expect(authSessionResponseSchema.parse(sessionFixture).account.id).toBe(accountId);
expect(() => loadRuntimeConfig({ NODE_ENV: "production" })).toThrow("GitHub OAuth");
expect(() => loadRuntimeConfig({ NODE_ENV: "production", AUTH_PROVIDER: "mock" })).toThrow();
```

- [ ] **Step 2: Run focused tests and confirm the new exports/configuration are absent**

Run: `bun x vitest run packages/contracts/test/auth.test.ts tests/contract/foundation-config.test.ts`  
Expected: FAIL because the auth schemas and runtime configuration do not exist.

- [ ] **Step 3: Add closed schemas and validated server-only configuration**

```ts
export const authProviderSchema = z.object({ id: z.enum(["github"]), label: z.literal("GitHub") }).strict();
export const authProvidersResponseSchema = z.object({ providers: z.array(authProviderSchema) }).strict();
export const authSessionResponseSchema = z.object({
  user: z.object({ id: z.string().uuid(), email: z.string().email() }).strict(),
  account: z.object({ id: z.string().uuid(), role: membershipRoleSchema, plan: z.string(), iaEnabled: z.boolean() }).strict(),
}).strict();
```

Add `AuthProvider = "github" | "mock"`, exact URL validation, duration bounds, base64 decoding for a 32-byte transient key, and required production variables `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL`, `AUTH_TRANSIENT_KEY`, `AUTH_DATABASE_URL`, `API_DATABASE_URL`, and `AUDIT_DATABASE_URL`. Reject `mock` outside development and never expose secret values in thrown messages.

- [ ] **Step 4: Run contract/type checks**

Run: `bun x vitest run packages/contracts/test/auth.test.ts tests/contract/foundation-config.test.ts && bun run typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/api/src/config.ts tests/contract/foundation-config.test.ts .env.example
git commit -m "feat: define GitHub authentication contracts"
```

### Task 2: Atomic multi-provider auth bootstrap migration

**Files:**

- Create: `packages/db/migrations/0019_provider_auth_workspace.sql`
- Create: `packages/db/test/provider-auth.integration.test.ts`
- Modify: `packages/db/test/schema.integration.test.ts`
- Modify: `packages/db/test/roles.isolation.test.ts`

- [ ] **Step 1: Write PostgreSQL tests for first, returning, and concurrent login**

```ts
const first = await completeProviderLogin("github", "12345", "owner@example.test", hashA);
const returning = await completeProviderLogin("github", "12345", "new@example.test", hashB);
expect(returning.user_id).toBe(first.user_id);
expect(returning.account_id).toBe(first.account_id);
expect(await count("account_membership", first.account_id)).toBe(1);
expect(await count("queue_tenant_state", first.account_id)).toBe(1);
expect(await auditTail(first.account_id)).toMatchObject({ actor: "github_oauth" });
```

Also run two simultaneous first-logins for the same subject and assert one user, one initial account, one owner membership, two valid sessions, and one queue tenant row. Assert rollback when the audit state is unavailable.

- [ ] **Step 2: Run the integration test against the dedicated local test database**

Run: `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun x vitest run packages/db/test/provider-auth.integration.test.ts --maxWorkers=1`  
Expected: FAIL because `auth_complete_provider_login` is absent.

- [ ] **Step 3: Add the narrow provider-neutral function**

```sql
CREATE FUNCTION public.auth_complete_provider_login(
  login_provider public.identity_provider,
  p_provider_subject text,
  login_email citext,
  session_hash text,
  session_expires_at timestamptz,
  client_ip inet,
  client_user_agent text
) RETURNS TABLE (account_id uuid, user_id uuid, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public;
```

The body must validate the provider/subject/hash/expiry, lock on `provider || ':' || subject`, resolve the global identity, create `account`, `user`, active owner `account_membership`, `queue_tenant_state`, and `audit_account_state` on first login, choose an active membership on return, insert the session, lock the audit state, append a linked redacted login event, and return IDs. Grant execute only to `auth_bootstrap`; revoke it from `PUBLIC`, `api_rls`, `worker_rls`, `reporting_rls`, and queue/admin roles. Keep a compatibility wrapper for existing Google rows until application callers are migrated.

- [ ] **Step 4: Run migration, integration, and isolation suites sequentially**

Run:

```bash
DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_integration_test bun run db:migrate
DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_isolation_test bun run db:migrate
RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_integration_test bun run test:integration --maxWorkers=1
RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_isolation_test bun run test:isolation --maxWorkers=1
```

Expected: PASS; `auth_bootstrap` can execute only fixed auth functions and cannot select tenant business tables.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0019_provider_auth_workspace.sql packages/db/test/provider-auth.integration.test.ts packages/db/test/schema.integration.test.ts packages/db/test/roles.isolation.test.ts
git commit -m "feat: provision provider workspaces atomically"
```

### Task 3: GitHub OAuth adapter and generalized auth routes

**Files:**

- Create: `apps/api/src/github-oauth-adapter.ts`
- Create: `apps/api/test/github-oauth-adapter.test.ts`
- Modify: `apps/api/src/auth.ts`
- Modify: `apps/api/test/auth.test.ts`
- Modify: `apps/api/src/oidc-adapter.ts`

- [ ] **Step 1: Add failing tests for GitHub authorization and profile mapping**

```ts
expect(start.headers.get("location")).toContain("github.com/login/oauth/authorize");
expect(start.headers.get("location")).toContain("code_challenge_method=S256");
expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ verifier: expect.any(String) }));
expect(store.completeProviderLogin).toHaveBeenCalledWith(expect.objectContaining({ provider: "github", providerSubject: "12345" }));
```

Cover state mismatch, callback replay, denied authorization, token response errors, request timeout, missing verified email, no token logging, cookie clearing, and successful redirect.

- [ ] **Step 2: Run the focused API tests**

Run: `bun x vitest run apps/api/test/auth.test.ts apps/api/test/github-oauth-adapter.test.ts`  
Expected: FAIL on missing provider-neutral types and adapter.

- [ ] **Step 3: Implement the provider adapter contract and GitHub HTTP adapter**

```ts
export type OAuthIdentity = Readonly<{ provider: "github" | "google"; subject: string; email: string }>;
export type OAuthAdapter = Readonly<{
  provider: OAuthIdentity["provider"];
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  authorizationParameters: Readonly<Record<string, string>>;
  exchangeCode(input: { code: string; verifier: string; redirectUri: string }): Promise<OAuthIdentity>;
}>;
```

The GitHub adapter posts form data to `https://github.com/login/oauth/access_token` with an explicit JSON accept header and bounded `AbortSignal.timeout`, then calls `https://api.github.com/user` and `/user/emails`. Accept only the numeric user `id` converted to decimal text and a primary verified email. Request `user:email`, `state`, and PKCE; discard response bodies and access-token references after mapping.

- [ ] **Step 4: Generalize routes without weakening Google validation**

Expose `/api/v1/auth/providers`, `/api/v1/auth/github/start`, `/api/v1/auth/github/callback`, `/api/v1/auth/session`, and `/api/v1/auth/logout`. Retain temporary aliases for `/auth/login` and `/auth/callback` only when Google is explicitly enabled. Bind the encrypted transient state to the provider and exact return origin. Use constant-time byte comparison for state values.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun x vitest run apps/api/test/auth.test.ts apps/api/test/github-oauth-adapter.test.ts && bun run typecheck`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth.ts apps/api/src/github-oauth-adapter.ts apps/api/src/oidc-adapter.ts apps/api/test/auth.test.ts apps/api/test/github-oauth-adapter.test.ts
git commit -m "feat: add secure GitHub OAuth flow"
```

### Task 4: Least-privilege PostgreSQL auth store

**Files:**

- Create: `packages/db/migrations/0020_auth_session_snapshot.sql`
- Create: `packages/db/src/auth-session.ts`
- Create: `packages/db/src/auth-connection-internal.ts`
- Create: `packages/db/test/auth-session.integration.test.ts`
- Modify: `packages/db/src/index.ts`
- Create: `apps/api/src/postgres-auth-store.ts`
- Create: `apps/api/test/postgres-auth-store.test.ts`
- Modify: `apps/api/package.json`

- [ ] **Step 1: Write failing tests for opaque connector and session operations**

```ts
const database = createAuthDatabase(process.env.AUTH_DATABASE_URL);
const result = await completeProviderLogin(database, input);
expect(result?.membershipStatus).toBe("active");
expect(await resolveAuthSession(database, input.sessionHash)).toMatchObject({ accountId: result?.accountId });
expect(await rotateAuthSession(database, rotation)).toMatchObject({ accountId: result?.accountId });
await revokeAuthSession(database, rotation.replacementSessionHash);
expect(await resolveAuthSession(database, rotation.replacementSessionHash)).toBeUndefined();
```

- [ ] **Step 2: Run focused DB/API store tests**

Run: `bun x vitest run packages/db/test/auth-session.integration.test.ts apps/api/test/postgres-auth-store.test.ts`  
Expected: FAIL because the opaque auth capability is absent.

- [ ] **Step 3: Implement fixed auth operations and adapter**

`createAuthDatabase` returns an opaque handle backed by a private WeakMap, never exports a raw SQL client, and exposes only:

```ts
completeProviderLogin(database, input): Promise<AuthSessionRecord | undefined>
resolveAuthSession(database, sessionHash): Promise<AuthSessionRecord | undefined>
rotateAuthSession(database, input): Promise<AuthSessionRecord | undefined>
revokeAuthSession(database, sessionHash): Promise<boolean>
listSessionAccounts(database, sessionHash): Promise<readonly AccountSummary[]>
switchAuthAccount(database, input): Promise<AuthSessionRecord | undefined>
acceptAuthInvitation(database, input): Promise<AuthInvitationAcceptance | undefined>
```

Every call invokes only the fixed database function with typed positional parameters. `createPostgresAuthStore` maps these records to `AuthStore`, preserving undefined for denied/expired sessions and never returning token hashes.

- [ ] **Step 4: Run DB/API tests and typecheck**

Run: `bun x vitest run packages/db/test/auth-session.integration.test.ts apps/api/test/postgres-auth-store.test.ts && bun run typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0020_auth_session_snapshot.sql packages/db/migrations/meta/_journal.json packages/db/src packages/db/test/auth-session.integration.test.ts apps/api/src/postgres-auth-store.ts apps/api/test/postgres-auth-store.test.ts apps/api/package.json bun.lock
git commit -m "feat: persist customer authentication sessions"
```

### Task 5: Persistent membership and assessment stores

**Files:**

- Create: `packages/db/src/membership-store.ts`
- Create: `packages/db/src/assessment-store.ts`
- Create: `packages/db/test/customer-workspace.integration.test.ts`
- Modify: `packages/db/src/index.ts`
- Create: `apps/api/src/postgres-membership-store.ts`
- Create: `apps/api/src/postgres-assessment-store.ts`
- Create: `apps/api/test/postgres-workspace-stores.test.ts`

- [ ] **Step 1: Write failing vertical persistence tests**

```ts
const owner = await loginGithub(subjectA);
const draft = await assessmentStore.create({ sessionHash: owner.hash, accountId: owner.accountId, input: authorizedDraft });
expect(await assessmentStore.list({ sessionHash: owner.hash, accountId: owner.accountId })).toContainEqual(expect.objectContaining({ id: draft.id, status: "draft" }));
expect(await membershipStore.listMemberships({ sessionHash: owner.hash, accountId: owner.accountId })).toEqual([expect.objectContaining({ role: "owner" })]);
expect(await assessmentStore.list({ sessionHash: other.hash, accountId: owner.accountId })).toEqual({ ok: false, code: "active_account_required" });
```

Cover invitation creation/acceptance, last-owner protection, session revocation on removal, draft persistence, queue enqueue through the existing closed function, queue projection, and cross-account denial.

- [ ] **Step 2: Run the focused integration test**

Run: `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun x vitest run packages/db/test/customer-workspace.integration.test.ts --maxWorkers=1`  
Expected: FAIL because production store capabilities are absent.

- [ ] **Step 3: Implement tenant-context capabilities**

Use `withTenant(database, "api_rls", accountId, callback)` and focused functions that derive account from `TenantContext`. Membership mutations must append audit in the same transaction. Assessment creation stores only normalized target/category, scope, playbook, limits, authorization version, and status `draft`. Queueing calls the existing `enqueueJob` after server policy checks; no runner or network action is introduced.

```ts
export async function listWorkspaceAssessments(context: TenantContext<"api_rls">): Promise<readonly AssessmentRecord[]>;
export async function createWorkspaceDraft(context: TenantContext<"api_rls">, input: AssessmentCreateRecord): Promise<AssessmentRecord>;
export async function queueWorkspaceAssessment(context: TenantContext<"api_rls">, input: QueueDraftInput): Promise<AssessmentRecord>;
```

- [ ] **Step 4: Adapt the API store interfaces and verify**

Run: `bun x vitest run apps/api/test/postgres-workspace-stores.test.ts && RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun x vitest run packages/db/test/customer-workspace.integration.test.ts --maxWorkers=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src packages/db/test/customer-workspace.integration.test.ts apps/api/src/postgres-membership-store.ts apps/api/src/postgres-assessment-store.ts apps/api/test/postgres-workspace-stores.test.ts
git commit -m "feat: persist customer workspace operations"
```

### Task 6: Real API composition and readiness boundary

**Files:**

- Create: `apps/api/src/runtime.ts`
- Create: `apps/api/test/runtime.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/app.test.ts`
- Modify: `packages/db/src/audit.ts`

- [ ] **Step 1: Write failing composition tests**

```ts
const runtime = await createRuntime(validProductionEnv, fakeConnectors);
expect(await runtime.app.request("/api/v1/auth/providers")).toHaveProperty("status", 200);
expect(runtime.dependencies).toMatchObject({ auth: expect.any(Object), membership: expect.any(Object), assessment: expect.any(Object) });
await expect(createRuntime(missingAuthEnv, fakeConnectors)).rejects.toThrow("authentication configuration unavailable");
```

Assert production never imports local mocks, mutations fail when audit append fails, `/health` reports liveness, and `/ready` returns non-200 until all required dependency probes pass.

- [ ] **Step 2: Run focused tests**

Run: `bun x vitest run apps/api/test/runtime.test.ts apps/api/test/app.test.ts`  
Expected: FAIL because the production composition root does not exist.

- [ ] **Step 3: Build and wire the composition root**

`createRuntime` validates config, creates GitHub/auth/tenant/audit dependencies, performs bounded connector probes, and returns `{ app, close }`. `server.ts` awaits the runtime before `Bun.serve` and calls `close` on shutdown. Replace the exported default `app` with a test-safe unavailable composition only in tests; production must use `createRuntime`.

- [ ] **Step 4: Run API suite and build**

Run: `bun x vitest run apps/api/test && bun run --cwd apps/api build && bun run typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test packages/db/src/audit.ts
git commit -m "feat: compose the production customer API"
```

### Task 7: PostgreSQL-backed local authentication and smoke flow

**Files:**

- Modify: `apps/api/src/local-development.ts`
- Modify: `apps/api/test/local-development.test.ts`
- Modify: `scripts/dev-local.ts`
- Modify: `scripts/local-smoke.ts`
- Modify: `infra/docker/compose.yml`

- [ ] **Step 1: Write failing local-flow tests**

```ts
expect(await request("/api/v1/auth/local/start", cookieJar)).toHaveProperty("status", 302);
expect(await request("/api/v1/auth/session", cookieJar)).toHaveProperty("status", 200);
expect(await request("/api/v1/accounts", cookieJar)).toHaveProperty("status", 200);
expect(await request("/api/v1/auth/logout", cookieJar, { method: "POST" })).toHaveProperty("status", 204);
expect(await request("/api/v1/accounts", cookieJar)).toHaveProperty("status", 401);
```

- [ ] **Step 2: Run local tests and observe the in-memory behavior**

Run: `bun x vitest run apps/api/test/local-development.test.ts`  
Expected: FAIL because local login and stores are not PostgreSQL-backed.

- [ ] **Step 3: Replace the local in-memory customer stores**

Use the same provider-neutral bootstrap and PostgreSQL stores with provider `github` and deterministic subject `local-github-user`. `/api/v1/auth/local/start` exists only when `NODE_ENV=development` and `LOCAL_MOCKS=1`, creates the session through the auth store, sets an insecure loopback cookie, and redirects to the web origin. Retain the separate in-memory admin demonstration because staff auth is outside this slice.

- [ ] **Step 4: Make local startup readiness-driven**

`dev-local.ts` must wait for PostgreSQL, migrate, derive local role-specific URLs, start four processes, wait for API/admin/web readiness, print URLs, forward signals, and close children. It must not interpret PostgreSQL NOTICE messages as failures.

- [ ] **Step 5: Run the live local stack and smoke**

Run in terminal A: `bun run dev:local`  
Run in terminal B: `bun run local:smoke`  
Expected: PASS for health, signed-out session, local login, PostgreSQL workspace, draft → queued, account isolation, logout denial, separate admin-cookie denial, and no external target contact.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/local-development.ts apps/api/test/local-development.test.ts scripts/dev-local.ts scripts/local-smoke.ts infra/docker/compose.yml
git commit -m "feat: run the local workspace on PostgreSQL"
```

### Task 8: Signed-out and authenticated customer frontend

**Files:**

- Create: `apps/web/src/auth-gateway.tsx`
- Create: `apps/web/src/auth-gateway.test.tsx`
- Create: `apps/web/src/api.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/app-shell.tsx`
- Modify: `apps/web/src/app.css`
- Modify: `apps/web/src/overview.tsx`

- [ ] **Step 1: Write failing UI tests for session-first loading**

```tsx
expect(screen.getByRole("button", { name: /continue with github/i })).toBeVisible();
expect(fetchMock).not.toHaveFetched("/api/v1/accounts");
await user.click(screen.getByRole("button", { name: /continue with github/i }));
expect(window.location.assign).toHaveBeenCalledWith(expect.stringContaining("/api/v1/auth/github/start"));
```

Cover checking session, signed out, provider unavailable, OAuth error code cleanup, authenticated load, empty workspace, retry, logout, narrow-screen navigation, and local mock sign-in label.

- [ ] **Step 2: Run focused web tests**

Run: `bun x vitest run apps/web/src/App.test.tsx apps/web/src/auth-gateway.test.tsx`  
Expected: FAIL because `App` loads accounts before resolving a session.

- [ ] **Step 3: Implement the session-first state machine**

```ts
type SessionState =
  | { kind: "checking" }
  | { kind: "signed-out"; providers: readonly AuthProvider[]; error?: string }
  | { kind: "authenticated"; session: AuthSessionResponse }
  | { kind: "unavailable"; message: string };
```

`App` fetches health/provider/session first. Only `authenticated` calls accounts, memberships, and assessments. A `401` becomes signed-out; `503` becomes retryable unavailable. Login navigates to the API start route; logout posts with credentials, clears tenant state, and renders signed-out. Remove copy that calls the production workspace unavailable when the user merely lacks a session.

- [ ] **Step 4: Polish accessible responsive UI**

Use the existing visual language and CSS tokens. Add visible focus states, status regions, reduced-motion support, readable empty states, a GitHub action with text label, mobile navigation, and disabled explanations for capabilities outside this slice. Do not add decorative images or a generic dashboard template.

- [ ] **Step 5: Run UI suite, accessibility-oriented queries, and build**

Run: `bun x vitest run apps/web/src && bun run --cwd apps/web build && bun run typecheck`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat: deliver the customer sign-in experience"
```

### Task 9: Production Compose, CI deployment, and remote smoke

**Files:**

- Modify: `infra/docker/compose.production.yml`
- Modify: `scripts/validate-production-compose.ts`
- Modify: `scripts/deploy-ovh.sh`
- Modify: `scripts/smoke-remote.sh`
- Modify: `.github/workflows/build-deploy.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/operations/ovh-deployment.md`

- [ ] **Step 1: Write failing deployment assertions**

```ts
expect(api.environment).toMatchObject({ AUTH_DATABASE_URL: expect.any(Object), API_DATABASE_URL: expect.any(Object), AUDIT_DATABASE_URL: expect.any(Object) });
expect(serialized).not.toContain("GITHUB_OAUTH_CLIENT_SECRET=");
expect(api.healthcheck.test).toContain("/ready");
```

Assert migration credentials are limited to the one-shot migrator, API secrets are environment references rather than interpolated build args, containers remain non-root/read-only where supported, and the web image contains only the public API base URL.

- [ ] **Step 2: Run compose/workflow checks and confirm failure**

Run: `docker compose -f infra/docker/compose.production.yml config && bun scripts/validate-production-compose.ts && bun x vitest run tests/contract/deployment.test.ts`  
Expected: FAIL because OAuth/runtime connector variables and readiness are not wired.

- [ ] **Step 3: Wire secret-safe runtime configuration and rollout**

Pass GitHub and role-specific database values only to the API container. The workflow checks required GitHub Environment secrets without printing them, uploads immutable artifacts, migrates, starts the candidate, waits on `/ready`, and runs `smoke-remote.sh`. The remote smoke verifies API health/readiness, app/admin origins, signed-out copy, provider discovery, and a 302 GitHub start whose redirect contains the expected client ID but no secret.

- [ ] **Step 4: Run deployment validation locally**

Run: `bun x vitest run tests/contract/deployment.test.ts && docker compose -f infra/docker/compose.production.yml config >/dev/null && bun scripts/validate-production-compose.ts && actionlint .github/workflows/*.yml`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/docker/compose.production.yml scripts/validate-production-compose.ts scripts/deploy-ovh.sh scripts/smoke-remote.sh .github/workflows docs/operations/ovh-deployment.md
git commit -m "ci: deploy the GitHub-authenticated workspace"
```

### Task 10: Authoritative docs and task reconciliation

**Files:**

- Modify: `README.md`
- Modify: `specs/001-touchmyapi-platform/spec.md`
- Modify: `specs/001-touchmyapi-platform/plan.md`
- Modify: `specs/001-touchmyapi-platform/research.md`
- Modify: `specs/001-touchmyapi-platform/data-model.md`
- Modify: `specs/001-touchmyapi-platform/contracts/index.md`
- Modify: `specs/001-touchmyapi-platform/quickstart.md`
- Modify: `specs/001-touchmyapi-platform/tasks.md`
- Create: `docs/reviews/2026-08-23-github-workspace-v1.md`

- [ ] **Step 1: Update the binding launch decision**

Change FR-001 and all launch-language from Google-only to GitHub OAuth App with Authorization Code, `state`, PKCE, exact callback, immutable provider subject, and no email auto-link. Record Google as deferred without changing the provider enum or staff-auth separation.

- [ ] **Step 2: Document runnable setup and external credential action**

README/quickstart must show exact Bun 1.4 commands, `dev:local`, `local:smoke`, role-specific database variables, GitHub OAuth App homepage/callback, safe secret placement, production readiness checks, and the fact that active execution remains disabled.

- [ ] **Step 3: Reconcile task statuses with evidence**

Add explicit tasks for GitHub adapter, provider-neutral bootstrap, persistent auth/membership/assessment stores, session-first web UI, local PostgreSQL smoke, and production wiring. Mark a task complete only beside its test/commit evidence. Leave staff admin, Stripe, active execution, reports, R2 enablement, and private agent open.

- [ ] **Step 4: Check documentation consistency**

Run:

```bash
rg -n "Google-only|exclusively via Google|GitHub/X are model-disabled|production assessment store.*open" README.md specs docs/operations
rg -n "T[B]D|T[O]DO|implement lat[e]r" README.md specs docs/superpowers docs/operations
bun x prettier --check README.md specs docs
```

Expected: the first command returns no stale launch claims; the second returns only intentional historical source quotations if any; formatting passes.

- [ ] **Step 5: Commit**

```bash
git add README.md specs docs
git commit -m "docs: reconcile the functional workspace release"
```

### Task 11: Full verification, review, integration, and deployment

**Files:**

- Modify only files required by failures discovered during this task.

- [ ] **Step 1: Run the complete static and unit gate**

Run:

```bash
bun run verify:workspace
bun run lint
bun run format
bun run typecheck
bun run test
bun run --cwd apps/api build
bun run --cwd apps/web build
bun run --cwd apps/admin build
docker compose --profile local -f infra/docker/compose.yml config >/dev/null
docker compose -f infra/docker/compose.production.yml config >/dev/null
bun scripts/validate-production-compose.ts
```

Expected: every command exits 0; skipped DB tests are reported separately and are not counted as coverage.

- [ ] **Step 2: Run full PostgreSQL gates on separate freshly migrated test databases**

Run:

```bash
DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_integration_test bun run db:migrate
DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_isolation_test bun run db:migrate
RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_integration_test bun run test:integration --maxWorkers=1
RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_isolation_test bun run test:isolation --maxWorkers=1
```

Expected: PASS with zero skipped integration/isolation tests caused by missing database configuration.

- [ ] **Step 3: Run live local acceptance and inspect logs**

Start `bun run dev:local`, run `bun run local:smoke`, inspect API/web/PostgreSQL logs for unhandled exceptions, `audit sink unavailable`, secret values, cross-account errors, or false unavailable states, then stop processes without deleting the database volume.

- [ ] **Step 4: Review the complete diff against the design and constitution**

Confirm no active target access, model execution, billing mutation, public bucket, raw token persistence, email auto-link, owner/BYPASSRLS runtime connector, customer/admin identity reuse, or browser-authoritative tenant selection was introduced.

- [ ] **Step 5: Push branch and open a PR**

```bash
git push -u origin feat/github-workspace-v1
gh pr create --base main --head feat/github-workspace-v1 --title "feat: deliver GitHub authentication and functional workspace" --body-file docs/reviews/2026-08-23-github-workspace-v1.md
gh pr checks --watch
```

Expected: all required GitHub checks pass.

- [ ] **Step 6: Merge and deploy after green checks**

```bash
gh pr merge --squash --delete-branch
gh run list --workflow build-deploy.yml --branch main --limit 1
gh run watch <run-id> --exit-status
```

Expected: merge succeeds, deployment workflow is green, and the post-deploy smoke confirms public sign-in/provider start. If the GitHub OAuth App credentials have not yet been created, deploy the fully tested code with the provider intentionally unavailable, record the exact external setup action, and do not claim real-provider acceptance.
