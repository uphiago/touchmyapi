# User/Admin Consoles and OVH Deployment Implementation Plan

> **For Codex:** Execute this plan sequentially with TDD and verification checkpoints. Do not mark T088–T094 complete when only local mocks/UI foundations exist.

**Goal:** Deliver a coherent locally functional customer console, a separately originated local admin control plane demonstration, and a hardened GitHub Actions-to-OVH deployment pipeline modeled on Barbarossa.

**Architecture:** Keep the existing customer API/web boundary and add an application-shell UI over its server-owned account/assessment/membership state. Add a second Hono composition and Vite application for development-only staff mocks on distinct ports, cookies, CORS, and state. Package deployable API/web/admin images in GHCR and cut them over on OVH through verified SSH, immutable SHA tags, migration-before-start, and remote health checks.

**Tech stack:** Bun, TypeScript, React 18, Vite, Hono, Zod contracts, Vitest, PostgreSQL 16, Docker Compose, GHCR, GitHub Actions, SSH/OVH.

---

## Task 1: Record executable task traceability

**Files:**

- Modify: `specs/001-touchmyapi-platform/tasks.md`
- Modify: `specs/001-touchmyapi-platform/quickstart.md`

**Step 1: Add scoped task entries**

Add explicit unchecked subtasks for the approved customer-console checkpoint, local-only admin composition, origin/session separation gate, production packaging, OVH workflow, and remote smoke. State that local admin mocks do not complete T088–T094.

**Step 2: Add the expected local ports**

Document customer web/API on `127.0.0.1:5173/3000` and admin web/API on `127.0.0.1:5174/3001`, with mock labeling and reset behavior.

**Step 3: Verify documentation formatting**

Run: `bun x prettier --check specs/001-touchmyapi-platform/tasks.md specs/001-touchmyapi-platform/quickstart.md`

Expected: PASS.

**Step 4: Commit**

```bash
git add -- specs/001-touchmyapi-platform/tasks.md specs/001-touchmyapi-platform/quickstart.md docs/superpowers/plans/2026-08-23-user-admin-ovh-implementation.md
git commit -m "docs: plan console and OVH delivery"
```

## Task 2: Define customer-console behavior with failing tests

**Files:**

- Create: `apps/web/src/App.test.tsx`
- Create: `apps/web/src/assessments.test.tsx`
- Modify: `apps/web/src/memberships.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/overview.tsx`
- Create: `apps/web/src/app-shell.tsx`

**Step 1: Write failing shell tests**

Tests must require:

- Overview/Assessments/Team/Workspace navigation labels;
- persistent local-mode notice when `VITE_LOCAL_MOCKS=1`;
- API health separate from authenticated workspace state;
- overview primary action and server-provided role/account context;
- no production claim that a queued mock assessment executed.

**Step 2: Run RED**

Run: `bun x vitest run --project unit apps/web/src/App.test.tsx`

Expected: FAIL because the operational shell does not exist.

**Step 3: Implement the minimum shell**

Create a state-driven accessible application shell without introducing a router dependency. Preserve the API client as the only customer data source. Keep prior safe data visible on refresh errors and add an explicit retry control.

**Step 4: Run GREEN**

Run: `bun x vitest run --project unit apps/web/src/App.test.tsx`

Expected: PASS.

## Task 3: Implement the guided assessment journey

**Files:**

- Create: `apps/web/src/assessment-wizard.tsx`
- Modify: `apps/web/src/assessments.tsx`
- Modify: `apps/web/src/assessments.test.tsx`
- Modify: `packages/contracts/src/assessment.ts`
- Modify: `apps/api/src/local-development.ts`

**Step 1: Write failing interaction/contract tests**

Cover category, target, scope entries, safe documented limits/playbook summary, explicit authorization attestation, review, draft save, close/focus behavior, and draft-to-queue action. Verify the local server supplies safe defaults and never claims real execution.

**Step 2: Run RED**

Run: `bun x vitest run --project unit apps/web/src/assessments.test.tsx`

Expected: FAIL because the wizard is absent.

**Step 3: Implement minimally**

Use one dialog/drawer with numbered steps and schema-validated submission. Do not store credentials, secrets, entitlement, or policy decisions in browser state.

**Step 4: Run GREEN and API regressions**

```bash
bun x vitest run --project unit apps/web/src/assessments.test.tsx apps/api/test/local-development.test.ts
bun x vitest run --project contract packages/contracts/test/assessment.test.ts
```

Expected: PASS.

## Task 4: Refine team/workspace surfaces and visual system

**Files:**

- Modify: `apps/web/src/account-switcher.tsx`
- Modify: `apps/web/src/memberships.tsx`
- Modify: `apps/web/src/app.css`
- Modify: `apps/web/src/index.html`

**Step 1: Add failing role/empty-state assertions**

Require human-readable workspace labels, safe shortened IDs, clear invite/accept separation, role-aware mutation copy, and token clearing after both success and error.

**Step 2: Run RED, then implement**

Run: `bun x vitest run --project unit apps/web/src/memberships.test.tsx`

Implement the approved control-room layout, responsive navigation, table-to-labeled-row behavior, focus styles, reduced motion, and non-color status cues.

**Step 3: Verify**

```bash
bun x vitest run --project unit apps/web/src
bun run --cwd apps/web build
```

Expected: PASS with no clipped primary action at 390px.

## Task 5: Define local admin contracts and deny-by-default composition

**Files:**

- Create: `packages/contracts/src/admin.ts`
- Create: `packages/contracts/test/admin.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/admin-local.ts`
- Create: `apps/api/src/admin-server.ts`
- Create: `apps/api/test/admin-local.test.ts`
- Modify: `apps/api/package.json`

**Step 1: Write failing contract tests**

Define closed schemas for local staff session, operations summary, safe account summary, queue metadata, capability request/approval, bounded queue action, and redacted audit event. Reject arbitrary capability/action names, TTLs outside bounds, global account targets, secret-shaped payload fields, and unbounded reaper sizes.

**Step 2: Run RED**

Run: `bun x vitest run --project contract packages/contracts/test/admin.test.ts`

Expected: FAIL because contracts do not exist.

**Step 3: Implement schemas and run GREEN**

Run the same command; expect PASS.

**Step 4: Write failing API tests**

Require:

- explicit development/mock composition;
- `tma-admin-session` cookie only;
- configured admin CORS origin only;
- no customer cookie acceptance;
- grant cannot self-approve or activate without distinct approver;
- queue action denied without matching active account/capability grant;
- reaper batch `1..100` only;
- redacted audit result after permitted action;
- no impersonation, secret/raw-evidence, arbitrary SQL, billing mutation, global reaper, or arbitrary dispatch route.

**Step 5: Run RED, implement an in-memory server store, run GREEN**

Run: `bun x vitest run --project unit apps/api/test/admin-local.test.ts`

Expected final result: PASS. Production customer server remains unchanged.

## Task 6: Build the separate admin application

**Files:**

- Create: `apps/admin/package.json`
- Create: `apps/admin/index.html`
- Create: `apps/admin/vite.config.ts`
- Create: `apps/admin/src/main.tsx`
- Create: `apps/admin/src/App.tsx`
- Create: `apps/admin/src/app.css`
- Create: `apps/admin/src/api-client.ts`
- Create: `apps/admin/src/App.test.tsx`
- Modify: `tsconfig.json`
- Modify: `bun.lock`

**Step 1: Write failing admin UI tests**

Require local staff bootstrap, persistent mock banner, operations/accounts/queue/access/billing/audit navigation, grant-before-action flow, read-only billing, disabled forbidden capabilities, expiry display, and safe error states.

**Step 2: Run RED**

Run: `bun x vitest run --project unit apps/admin/src/App.test.tsx`

Expected: FAIL because `apps/admin` is absent.

**Step 3: Implement**

Use the approved visual system with a distinct staff accent and explicit control-plane label. All mutations go through the admin API client; no browser-only grant activation.

**Step 4: Run GREEN and build**

```bash
bun x vitest run --project unit apps/admin/src/App.test.tsx
bun run --cwd apps/admin build
```

Expected: PASS.

## Task 7: Integrate the four-process local stack and smoke

**Files:**

- Modify: `scripts/dev-local.ts`
- Modify: `scripts/local-smoke.ts`
- Modify: `package.json`
- Modify: `tests/contract/foundation-config.test.ts`

**Step 1: Write failing topology tests**

Require canonical origins `3000/5173` for customers and `3001/5174` for admin, separate CORS values/cookies, explicit local flags, and shutdown propagation for all children.

**Step 2: Run RED**

Run: `bun x vitest run --project contract tests/contract/foundation-config.test.ts`

Expected: FAIL because admin processes are not present.

**Step 3: Implement and run local smoke**

Extend `dev:local` to start both API compositions and both Vite apps. Extend smoke to prove:

- customer CORS/session plus draft-to-queue;
- admin CORS/staff session;
- grant request, distinct approval, bounded queue action, and redacted audit;
- customer cookie rejected by admin and admin cookie rejected by customer.

Run: `bun run local:smoke`

Expected: all customer/admin checks PASS.

## Task 8: Package production containers and Compose

**Files:**

- Create: `.dockerignore`
- Create: `apps/api/Dockerfile`
- Create: `apps/web/Dockerfile`
- Create: `apps/admin/Dockerfile`
- Create: `infra/docker/compose.production.yml`
- Create: `infra/docker/nginx/web.conf`
- Create: `infra/docker/nginx/admin.conf`
- Create: `scripts/validate-production-compose.ts`
- Modify: `tests/contract/foundation-config.test.ts`

**Step 1: Verify current official base-image guidance**

Use official Bun and Docker/Nginx sources. Pin release images by version and digest where practical; record the selected versions in comments or the deployment runbook.

**Step 2: Write failing packaging contract tests**

Require non-root runtime, no local mocks, no source `.env`, no public PostgreSQL port, health checks, loopback application binds, immutable `TOUCHMYAPI_IMAGE_TAG`, separate admin/customer origins, and migration one-shot capability.

**Step 3: Run RED**

Run: `bun x vitest run --project contract tests/contract/foundation-config.test.ts`

**Step 4: Implement images/Compose and run GREEN**

```bash
docker build -f apps/api/Dockerfile -t touchmyapi-api:test .
docker build -f apps/web/Dockerfile -t touchmyapi-web:test .
docker build -f apps/admin/Dockerfile -t touchmyapi-admin:test .
bun scripts/validate-production-compose.ts
```

Expected: all images build without production secrets and Compose validates.

## Task 9: Implement the hardened GitHub-to-OVH release

**Files:**

- Create: `.github/workflows/build-deploy.yml`
- Create: `scripts/deploy-ovh.sh`
- Create: `scripts/smoke-remote.sh`
- Create: `tests/contract/deployment-workflow.test.ts`
- Create: `docs/operations/ovh-deployment.md`

**Step 1: Write failing workflow tests**

Parse the workflow and require jobs `validate`, `build-images`, and `deploy`; exact dependencies; PR validation only; deploy only on manual dispatch/tag; full-SHA pinned actions; minimal permissions; `production` environment; serialized concurrency; `OVH_HOST_KEY`; `StrictHostKeyChecking=yes`; no `ssh-keyscan`; no `StrictHostKeyChecking=no`; GHCR SHA tags; migration before cutover; remote smoke after cutover.

**Step 2: Run RED**

Run: `bun x vitest run --project contract tests/contract/deployment-workflow.test.ts`

Expected: FAIL because the workflow is absent.

**Step 3: Implement workflow and host scripts**

Adapt the reviewed Barbarossa pattern. Preserve `$HOME/touchmyapi/shared/.env`, upload with `git archive`, authenticate GHCR through stdin, pass the exact SHA to Compose, bound pruning to TouchMyAPI images, and record prior/current release SHA.

**Step 4: Run GREEN and shell checks**

```bash
bun x vitest run --project contract tests/contract/deployment-workflow.test.ts
sh -n scripts/deploy-ovh.sh scripts/smoke-remote.sh
```

Expected: PASS.

## Task 10: End-to-end verification, visual review, and handoff

**Files:**

- Modify: `README.md`
- Modify: `specs/001-touchmyapi-platform/tasks.md`
- Modify: `specs/001-touchmyapi-platform/quickstart.md`
- Create: `docs/reviews/2026-08-23-console-admin-ovh-checkpoint.md`

**Step 1: Run all fast gates**

```bash
bun run verify:workspace
bun run test
bun run typecheck
bun run lint
bun run format
bun run --cwd apps/web build
bun run --cwd apps/admin build
bun run local:smoke
```

Expected: PASS.

**Step 2: Run PostgreSQL gates on separately migrated databases**

```bash
RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_review_integration_test bun run test:integration --maxWorkers=1
RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_review_isolation_test bun run test:isolation --maxWorkers=1
```

Expected: all integration and isolation tests PASS.

**Step 3: Review live desktop/mobile captures**

Capture customer and admin at `1440x1200` and `390x844`. Verify navigation, primary actions, mock banners, queue/grant states, no overflow, and readable empty/error states. Fix any issue through a failing regression test first.

**Step 4: Update truthful task state**

Mark only the new checkpoint subtasks complete. Keep production admin/backend tasks T088–T092 and real deployment external provisioning unchecked until their acceptance criteria are actually proven.

**Step 5: Commit and push**

Stage only reviewed files, commit coherent checkpoints, push `feat/foundation-phase2`, and report the GitHub branch plus required external secret/provisioning checklist.
