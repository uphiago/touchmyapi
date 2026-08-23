# T016 tenant capability boundary implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the public arbitrary-SQL tenant callback and prove that a post-validation ACL grant cannot create a new tenant operation.

**Architecture:** Preserve the reserved PostgreSQL backend and local role/tenant lifecycle in `tenant-session.ts`. Replace `TenantConnection.unsafe` with a frozen `TenantContext` backed by an internal `WeakMap`; `tenant-account.ts` provides the first fixed repository operation. Future `audit.ts` will use the same transaction-bound internal capability.

**Tech Stack:** Bun 1.4.0, TypeScript strict, postgres.js, PostgreSQL 16, Vitest integration/isolation suites.

---

### Task 1: Write the RED regression tests

**Files:**
- Modify: `packages/db/test/tenant-session.integration.test.ts`
- Modify: `packages/db/test/roles.isolation.test.ts` only if a public-export assertion belongs there

- [x] **Step 1: Add the closed-surface assertion**

Replace callbacks that call `tenant.unsafe(...)` with the desired repository call and assert the public object has no `unsafe`, `query`, `sql`, or raw-connection member:

```ts
await withTenant(connection, fixture.accountA, "api_rls", async (tenant) => {
  expect("unsafe" in tenant).toBe(false);
  expect(await tenant.account.readCurrent()).toMatchObject({ id: fixture.accountA });
});
```

- [x] **Step 2: Add the live-grant RED test**

After `withTenant` has completed its switch preflight, use the migration-admin fixture connection to grant a harmless probe function or table privilege to `api_rls`. The callback must have no way to invoke the newly granted object; its fixed `account.readCurrent()` call still returns only the selected account. The test initially fails because the old callback has `unsafe`.

- [x] **Step 3: Run RED**

Run:

```bash
PATH=/tmp/touchmyapi-bun-1.4.0:$PATH RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run test:integration -- tenant-session
```

Expected: failure specifically because `unsafe` exists or the requested closed capability does not exist.

### Task 2: Replace the callback surface with closed capabilities

**Files:**
- Modify: `packages/db/src/tenant-session.ts`
- Create: `packages/db/src/tenant-internal.ts`
- Create: `packages/db/src/tenant-account.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/package.json` only if an explicit export test requires it

- [x] **Step 1: Implement the opaque context**

Export `RuntimeRole`, opaque `TenantDatabase`, and `TenantContext<R>` from the package root. Give the context `role`, `account.readCurrent()`, and the API-role-only `account.setIaEnabled(boolean)` capability; worker/reporting receive no setter. Keep the account identifier in the private active-executor record; callers cannot pass it to a repository operation.

- [x] **Step 2: Implement the private executor**

Use a module-local `WeakMap` keyed by the context. The record contains the reserved backend, canonical account ID, role, and active flag. It exposes a relative-import-only helper for fixed repository modules, which rejects an expired context before executing a literal statement with bound values. Do not export that helper from `index.ts` or add a package subpath export.

- [x] **Step 3: Implement the account repository**

`readCurrent()` executes a literal parameterized select for the current context account. It returns a closed account row shape and never accepts a table, SQL fragment, or account ID. Bind the context-derived account ID even though RLS also scopes it.

- [x] **Step 4: Run GREEN**

Run the focused integration suite from Task 1 and then:

```bash
PATH=/tmp/touchmyapi-bun-1.4.0:$PATH RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run test:isolation --maxWorkers=1
PATH=/tmp/touchmyapi-bun-1.4.0:$PATH bun run typecheck
PATH=/tmp/touchmyapi-bun-1.4.0:$PATH bun run lint
PATH=/tmp/touchmyapi-bun-1.4.0:$PATH bun run format
git diff --check
```

Expected: all commands exit 0; the grant probe is revoked in test cleanup.

### Task 3: Record acceptance evidence

**Files:**
- Modify: `specs/001-touchmyapi-platform/tasks.md`
- Modify: `docs/reviews/2026-08-22-foundation-checkpoint.md`
- Modify: `docs/superpowers/plans/2026-08-22-foundation-phase2.md`

- [x] **Step 1: Update task status only after review approval**

Mark T016 accepted only after its spec and adversarial quality reviews return Ready: Yes. Replace old `unsafe` wording in the Foundation plan with the selected closed capability boundary and link this plan/design.

- [x] **Step 2: Commit**

```bash
git add -- packages/db/src/tenant-session.ts packages/db/src/tenant-internal.ts packages/db/src/tenant-account.ts packages/db/src/index.ts packages/db/test/tenant-session.integration.test.ts packages/db/test/roles.isolation.test.ts specs/001-touchmyapi-platform/tasks.md docs/reviews/2026-08-22-foundation-checkpoint.md docs/superpowers/specs/2026-08-22-tenant-capability-boundary-design.md docs/superpowers/plans/2026-08-22-t016-capability-boundary.md docs/superpowers/plans/2026-08-22-foundation-phase2.md
git commit -m "fix: close tenant capability boundary"
```
