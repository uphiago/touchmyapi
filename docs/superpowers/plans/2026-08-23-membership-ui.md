# Server-driven membership UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Replace the Vite health shell with a server-driven account switcher and membership workspace that never treats browser state as authorization.

**Architecture:** Add a small fetch client under `packages/ui/api-client.ts` that validates account, membership, invitation, and stable error responses with the existing contracts. Keep React state local to `App`, pass server snapshots into focused `AccountSwitcher` and `Memberships` components, and submit every mutation through credentialed JSON requests. The UI only reflects server-provided roles/statuses; the API remains authoritative.

**Tech Stack:** React 18, TypeScript, Vite, Zod contracts, Vitest, CSS modules-by-convention in `apps/web/src/app.css`.

---

### Task 1: Create the typed credentialed API client

**Files:**
- Create: `packages/ui/api-client.ts`
- Create: `packages/ui/package.json`
- Modify: `vitest.config.ts`
- Modify: `packages/contracts/src/membership.ts`, `packages/contracts/src/index.ts`
- Test: `apps/web/src/memberships.test.tsx`

- [x] **Step 1: Write failing client tests**

Add a `fetch` mock that asserts `credentials: "include"`, JSON `Content-Type` for mutations, and these exact paths: `GET /api/v1/accounts`, `POST /api/v1/account/switch`, `GET /api/v1/accounts/:accountId/memberships`, `POST /api/v1/accounts/:accountId/memberships/invitations`, and `POST /api/v1/invitations/accept`. Assert invitation acceptance sends `{ token }` only in `body` and never in `Request.url`.

- [x] **Step 2: Run the focused test and verify failure**

Run `bun run test:unit -- memberships`; expected failure because `packages/ui/api-client.ts` and its exported functions do not exist.

- [x] **Step 3: Implement the client boundary**

Export `createApiClient(baseUrl: string, fetcher = fetch)` with methods:

```ts
type ApiClient = {
  listAccounts(): Promise<AccountListResponse>;
  switchAccount(accountId: string): Promise<{ account: { id: string; role: MembershipRole } }>;
  listMemberships(accountId: string): Promise<MembershipListResponse>;
  createInvitation(accountId: string, input: InvitationCreate): Promise<InvitationCreateResponse>;
  acceptInvitation(token: string): Promise<{ account: { id: string; role: MembershipRole } }>;
};
```

Use `response.json()` only after checking `response.ok`; parse success with the matching Zod schema, parse stable `{ error: { code, message } }` failures, and throw an `ApiClientError` containing `status`, `code`, and `message`. Do not log request bodies or URL query parameters.

- [x] **Step 4: Run client tests**

Run `bun run test:unit -- memberships`; expected PASS with body-only token assertions.

- [x] **Step 5: Commit the client boundary**

Run:

```bash
git add packages/ui apps/web/package.json apps/web/src/memberships.test.tsx
git commit -m "feat: add credentialed membership api client"
```

### Task 2: Build the account switcher from server snapshots

**Files:**
- Create: `apps/web/src/account-switcher.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/memberships.test.tsx`

- [x] **Step 1: Add failing rendering tests**

Render the component with two `AccountSummary` values and assert the active account is selected, role/status labels are rendered from response values, and selecting another account calls `client.switchAccount` with its UUID. Assert no role string is used to bypass the callback; the component always delegates to the supplied handler.

- [x] **Step 2: Implement `AccountSwitcher`**

Use props `{ accounts, busy, onSwitch }`. Render a labelled `<select>` with account IDs, role, and status; disable it while `busy`; call `onSwitch` from `onChange`. Derive the selected option only from `active === true`, falling back to the first account without mutating permissions.

- [x] **Step 3: Integrate account loading and switching in `App`**

Create the client once from `VITE_API_BASE_URL`, load accounts on mount with cancellation, store only the parsed server response, and after a successful switch reload accounts and memberships. Display `ApiClientError.message` in an `aria-live="polite"` region; do not optimistically update the active account.

- [x] **Step 4: Run focused tests**

Run `bun run test:unit -- memberships`; expected PASS for active-account and switch behavior.

### Task 3: Build membership list and safe invitation forms

**Files:**
- Create: `apps/web/src/memberships.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/memberships.test.tsx`

- [x] **Step 1: Add failing form tests**

Assert membership rows show role and status from server data. Submit invite form and assert the client receives `{ email, role, expiresAt }` as JSON. Submit accept form and assert `{ token }` is the only token-bearing value, the token is cleared after submission, and no DOM anchor or `window.location` contains it.

- [x] **Step 2: Implement `Memberships`**

Use props `{ accountId, memberships, onInvite, onAccept, busy }`. Render rows from the array; render email, role, expiry, and role selection controls; use a default expiry of seven days; expose buttons with disabled state while mutations are pending. Do not hide or enable actions based on role in this component; server errors remain authoritative.

- [x] **Step 3: Wire refresh behavior**

`App` fetches memberships only for the server-selected active account. On successful invite or accept, reload the account snapshot and membership list. Keep invitation token in a local input only, clear it in `finally`, and never include it in status text.

- [x] **Step 4: Run focused tests**

Run `bun run test:unit -- memberships`; expected PASS for list, invite, accept, and token non-disclosure behavior.

### Task 4: Apply the industrial workspace visual treatment

**Files:**
- Modify: `apps/web/src/app.css`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/index.html`

- [x] **Step 1: Implement layout and accessible states**

Create a responsive two-column desktop / one-column mobile workspace with dark graphite background, amber focus accent, blue links, clear status badges, visible field labels, `fieldset` grouping, and loading/empty/error states. Keep all interactive controls keyboard reachable and preserve reduced-motion preferences.

- [x] **Step 2: Build the web app**

Run `bun run --cwd apps/web build`; expected PASS with no missing asset or TypeScript errors.

### Task 5: Run the T078 gate and update project records

**Files:**
- Create: `scripts/dev-local.ts`, `scripts/local-smoke.ts`
- Modify: `package.json`, `specs/001-touchmyapi-platform/quickstart.md`
- Modify: `specs/001-touchmyapi-platform/tasks.md`
- Modify: `docs/superpowers/plans/2026-08-23-phase2a-membership.md`
- Modify: `docs/reviews/2026-08-23-multiuser-membership-foundation.md`
- Modify: `README.md`

- [x] **Step 1: Run focused and repository checks**

Run `bun run test:unit -- memberships`, `bun run typecheck`, `bun run lint`, `bun run format`, `bun run --cwd apps/web build`, and `git diff --check`; all must exit 0.

Also run the local runtime smoke gate in two terminals:

```bash
bun run dev:local
bun run local:smoke
```

Expected output includes `PASS API health`, `PASS web shell`, and
`local stack is responding`; inspect `bun run local:logs` before stopping the
application processes with `Ctrl-C`.

The local composition must also expose `GET /api/v1/auth/local-session`, return
two demo accounts, allow a switch to the second account, and list its
membership. This route is available only when `LOCAL_MOCKS=1` in development.

- [x] **Step 2: Record T078 evidence**

Mark T078 complete only with the focused tests and build evidence. Keep T076 production store/deletion, T079 migration review, and T080 acceptance gate explicitly pending.

- [x] **Step 3: Commit and push**

Run:

```bash
git add packages/ui apps/web packages/ui/package.json specs/001-touchmyapi-platform/tasks.md docs/superpowers/plans/2026-08-23-phase2a-membership.md docs/reviews/2026-08-23-multiuser-membership-foundation.md README.md
git commit -m "web: add explicit account membership controls"
git push origin feat/foundation-phase2
```
