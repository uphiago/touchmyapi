# GitHub Authentication and Functional Workspace V1

**Date:** 2026-08-23  
**Status:** Approved by product direction  
**Branch:** `feat/github-workspace-v1`

## Outcome

Turn the currently deployed public shell into a coherent first-run product flow:

1. an unauthenticated visitor sees a real sign-in page instead of a broken workspace;
2. GitHub authenticates the visitor through Authorization Code with `state` and PKCE;
3. the server creates or resolves the global identity, first workspace, owner membership,
   queue tenant state, session, and audit record in PostgreSQL;
4. the authenticated user reaches a tenant-isolated workspace whose account, membership,
   assessment, and queue views are backed by production stores;
5. local development remains fully usable without external credentials through an explicit
   development-only mock provider;
6. production remains default-deny when required dependencies or credentials are absent.

This is a control-plane slice. It does not enable active security execution, billing,
report generation, or private agents.

## Product decision

Use a GitHub OAuth App for customer identity in V1. A GitHub App is deferred until the
product needs repository installations or repository permissions. The login flow requests
only the identity/email access needed to establish the TouchMyAPI identity and does not
persist the GitHub access token.

Google remains a modeled future provider. The existing Google-specific implementation is
generalized rather than duplicated. Automatic identity linking by email is forbidden.

## User experience

### Signed out

`app.touchmyapi.com` renders a public product entry screen with one primary action,
**Continue with GitHub**. The application does not request `/accounts`, memberships, or
assessments before it has resolved the session.

The page has explicit states:

- checking session;
- signed out;
- redirecting to GitHub;
- OAuth failure with a safe retry action;
- temporarily unavailable when the API dependency boundary is down.

Raw provider errors, tokens, state values, stack traces, and internal availability details
are never rendered.

### First login

The first successful GitHub login creates a personal workspace with a deterministic display
name derived from the GitHub login, subject to normalization and collision-safe suffixing.
The user becomes `owner` and lands on the workspace overview. Provisioning is idempotent:
replaying a callback or logging in concurrently cannot create duplicate users, memberships,
accounts, or queue state.

### Returning login and multiple workspaces

The immutable identity key is `(provider = github, provider_subject = GitHub numeric user
id)`. A returning user receives a new rotating server session for an active membership.
When multiple memberships exist, the server selects the last valid account if available,
otherwise the oldest active membership. The account switch endpoint validates membership
and rotates the session family; browser-supplied account IDs never become authorization.

### Workspace

The workspace presents:

- current account and role;
- account switcher when more than one active membership exists;
- members and pending invitations according to role capabilities;
- assessment list with an empty state and a create-draft action;
- queue/status visualization derived from persisted assessment/job state;
- clear disabled explanations for execution, billing, reports, and integrations that are
  intentionally outside this slice.

No control implies functionality that the server does not yet provide. Active execution is
not exposed.

## Authentication flow

1. `GET /api/v1/auth/github/start` creates a cryptographically random `state` and PKCE
   verifier, stores only an authenticated/encrypted short-lived transient cookie, and
   redirects to GitHub.
2. GitHub returns to `GET /api/v1/auth/github/callback` with `code` and `state`.
3. The API requires an exact state match, single-use transient state, bounded age, and the
   original PKCE verifier.
4. The API exchanges the code server-to-server using the OAuth App secret.
5. The API calls GitHub's authenticated-user endpoint and, when necessary, the authenticated
   email endpoint. It accepts a primary verified email; if no usable verified email exists,
   login fails with a user-actionable message instead of inventing an identity address.
6. The access token is held only in request memory, is never logged or persisted, and is
   discarded after profile retrieval.
7. A narrow `auth_bootstrap` database function completes identity/workspace/session
   provisioning and mandatory audit recording atomically.
8. The API sets an opaque session cookie and redirects to the configured web origin with no
   OAuth parameters.

The session cookie is `HttpOnly`, `Secure` in production, `SameSite=Lax`, path `/`, and uses
the host-only `__Secure-tma-session` name. PostgreSQL stores only a SHA-256 token hash.
Session resolution rotates the raw token. Logout revokes the current family and clears the
cookie.

## Data model and database boundary

The `identity_provider` enum already models `github`. The following migration generalizes
the narrow auth function:

- replace `auth_complete_google_login(...)` with
  `auth_complete_provider_login(provider, provider_subject, email, display_name,
  session_hash, session_expires_at, ip, user_agent)`;
- accept only the closed `identity_provider` enum and reject disabled providers at the API
  boundary;
- serialize first-login provisioning by provider plus provider subject;
- insert the global user only when the immutable provider identity does not exist;
- create an account, active owner membership, and `queue_tenant_state` only when the user has
  no active membership;
- create a session bound to a valid active membership;
- append the authentication/provisioning audit event within the same transaction or abort;
- retain `SECURITY DEFINER`, a fixed safe `search_path`, strict input validation, and execute
  permission only for `auth_bootstrap`.

Existing sessions and Google identities remain readable. The old function is removed only
after all callers and tests move to the provider-neutral contract.

Runtime API access uses separate least-privilege connectors:

- `AUTH_DATABASE_URL`: login/session bootstrap functions only;
- `API_DATABASE_URL`: `api_rls` tenant transactions only;
- `AUDIT_DATABASE_URL`: narrow audit writer only;
- migration credentials are never mounted into a running API container.

The API startup composition must construct real auth, membership, assessment, queue, and
audit dependencies from these connectors. A process missing any dependency required for a
route advertises the route as unavailable and fails closed; it must not silently instantiate
an empty in-memory or unavailable sink in production.

## API contract

Public authentication routes:

- `GET /api/v1/auth/providers` returns enabled public provider metadata, never secrets;
- `GET /api/v1/auth/github/start` starts OAuth;
- `GET /api/v1/auth/github/callback` completes OAuth and redirects;
- `GET /api/v1/auth/session` returns the sanitized current session or `401`;
- `POST /api/v1/auth/logout` revokes and clears the session.

Authenticated tenant routes retain the server-selected account boundary:

- `GET /api/v1/accounts`;
- `POST /api/v1/accounts/:accountId/switch`;
- membership and invitation routes already defined by the project contracts;
- assessment list/create-draft routes;
- read-only queue/status projection routes.

Responses use closed schemas from `packages/contracts`. Authentication failures distinguish
`401` from dependency `503`, but public messages remain generic. Request logs redact cookies,
authorization headers, OAuth codes, state, verifier, invitation tokens, and email query data.

## Local development

`bun run dev:local` remains the single entry point. It must:

1. start PostgreSQL;
2. wait for readiness;
3. run migrations with migration credentials;
4. bootstrap least-privilege local runtime roles/connectors;
5. start the API and web app with `AUTH_PROVIDER=mock` explicitly enabled;
6. expose a development sign-in action that creates a deterministic local identity through
   the same provider-neutral PostgreSQL function;
7. print service URLs and perform a readiness check.

The mock provider is rejected when `NODE_ENV=production`. It uses PostgreSQL, real sessions,
memberships, RLS, audit, assessments, and queue state; only the external GitHub redirect and
profile exchange are replaced.

`bun run local:smoke` exercises signed-out state, mock login, session rotation, workspace
load, draft creation, account isolation, logout, and post-logout denial while the services
are running.

## Production configuration and deployment

Required secrets/variables:

- `GITHUB_OAUTH_CLIENT_ID`;
- `GITHUB_OAUTH_CLIENT_SECRET`;
- `GITHUB_OAUTH_CALLBACK_URL=https://api.touchmyapi.com/api/v1/auth/github/callback`;
- `WEB_APP_ORIGIN=https://app.touchmyapi.com`;
- `AUTH_TRANSIENT_KEY` with at least 256 bits;
- `AUTH_DATABASE_URL`, `API_DATABASE_URL`, and `AUDIT_DATABASE_URL` using distinct runtime
  roles.

The OAuth App homepage is `https://app.touchmyapi.com`. Secrets live only in the encrypted
GitHub Actions/OVH deployment environment and the remote root-readable env file; they never
enter the repository, image layers, frontend variables, or workflow logs.

Deployment order is migrate, start candidate containers, internal readiness, external
smoke, and then success. A failed migration or smoke retains/recovers the last healthy
release. The smoke test verifies the signed-out page and provider-start response without
attempting to automate a real GitHub user authorization.

## Queue and multi-user behavior

First-workspace creation always initializes `queue_tenant_state`, so later enqueue never
depends on lazy repair. Draft assessments are account-scoped and do not enter the queue.
Only the existing policy/entitlement-controlled enqueue boundary may create jobs. The UI
visualizes queued/running/terminal state but cannot alter queue internals.

Invitations remain explicit and single-use. An email match never grants membership. A GitHub
identity may own or join multiple accounts. Last-owner protections, role capabilities,
account switching, and all cross-account denial tests remain mandatory.

## Admin boundary

Customer GitHub authentication does not authenticate staff. The separate admin origin/API,
staff identity, MFA, JIT support grants, and break-glass design remain fail-closed and outside
this slice. The admin page will show an honest unavailable/setup state until that separate
security boundary is implemented; customer credentials are never reused to make the admin
screen appear functional.

## Failure handling

- Missing GitHub configuration: provider is not offered; production readiness identifies
  authentication as unavailable without leaking the missing secret name publicly.
- OAuth denied or expired: transient cookie is cleared and the web app receives a stable
  generic error code with retry.
- State/PKCE mismatch or replay: reject, audit, clear transient state, create no session.
- GitHub timeout/rate limit: bounded timeout, no blind retry of code exchange, safe retry from
  the start route.
- Database or mandatory audit failure: no account/session mutation is committed.
- Suspended membership/account: no session is created or rotated into it.
- Invalid/expired session: clear cookie and render signed-out state, not “workspace
  unavailable.”

## Test strategy

Implementation is test-driven and adds:

- unit tests for provider configuration, state, PKCE, transient cookies, profile mapping,
  verified email selection, redaction, session cookies, and UI state transitions;
- contract tests for provider discovery and sanitized session/account responses;
- PostgreSQL integration tests for first login, returning login, concurrent login,
  idempotency, queue state, mandatory audit, and session rotation;
- isolation tests proving the bootstrap connector cannot access tenant business tables and
  `api_rls` cannot call auth bootstrap functions;
- multi-user tests for account switching, invitation acceptance, role denial, last-owner
  protection, and cross-account inference/read/write denial;
- end-to-end local smoke tests covering login through logout with real PostgreSQL;
- production deployment smoke tests for public origins, health/readiness, sign-in page, and
  OAuth start without exposing secrets.

## Acceptance criteria

The slice is complete when:

1. a clean `bun run dev:local` produces a working mock login and PostgreSQL-backed workspace;
2. a new GitHub user can sign in and receives exactly one owner workspace;
3. returning and concurrent logins do not duplicate data;
4. session rotation, logout, account switching, invitations, draft assessment operations,
   and queue visualization work through the real persistence boundary;
5. cross-account and least-privilege connector tests pass;
6. production renders a sign-in experience instead of “No active accounts / API
   unavailable”;
7. required checks, deployment, and post-deploy smoke tests pass;
8. README, quickstart, environment example, operational runbook, specification, data model,
   contracts, and task tracker reflect GitHub V1 and the remaining external credential step.

## Deferred work

- Google and X customer authentication;
- GitHub repository installation/access;
- staff/admin authentication and JIT operations;
- Stripe billing and entitlements;
- active assessment execution and private agents;
- report generation and R2 artifacts.

