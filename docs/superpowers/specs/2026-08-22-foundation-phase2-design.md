# TouchMyAPI Foundation Phase 2 Design

**Date:** 2026-08-22  
**Status:** Approved for autonomous implementation  
**Scope:** Foundation remediation plus tasks T010-T021

## Goal

Build the complete security foundation required before any assessment user story: reproducible quality gates, the default-deny policy engine, PostgreSQL tenant isolation, secure persistence primitives, a passive playbook catalog, and Google OAuth sessions. This increment must not execute assessments, contact targets, expose a scanner, or introduce billing mutations.

The constitution remains authoritative. If this design, the task list, and implementation details disagree, the safest constitution-compliant behavior wins and the drift is documented.

## Delivery strategy

Work proceeds through five gates. A gate advances only after its focused tests pass, its implementation matches this design, and its code-quality review has no open critical or important issue.

1. Reproducible foundation and corrected security-test topology.
2. Pure policy authority (T010-T013).
3. PostgreSQL schema, roles, RLS, tenant transactions, and audit persistence (T014-T017).
4. Credential AEAD and the passive playbook catalog (T018-T019).
5. Hono application boundary and Google OAuth/session flow (T020-T021).

Implementation uses Bun 1.4.0, TypeScript strict mode, Vitest, Hono, Zod, Drizzle, and PostgreSQL 16. Each behavior change follows test-first red-green-refactor. The branch lives in an isolated worktree.

## Non-goals

- No assessment CRUD, state-machine service, queue, worker, sandbox, runner, target fetch, or network probe.
- No HTTP verification implementation; only policy-level rejection of DNS-TXT as an authorization gate.
- No Stripe routes, entitlement mutation, reports, object download, AI provider, or private agent.
- No frontend feature work beyond preserving the existing health shell.
- No organization/team model, email-based account linking, generic shell, or privileged database fallback.

## Architecture and dependency direction

Dependencies point inward:

```text
packages/contracts
        ^
        |
packages/policy     packages/playbooks     packages/secrets
        ^                    ^                    ^
        |                    |                    |
        +-------------- apps/api ----------------+
                            |
                        packages/db
                            |
                        PostgreSQL RLS
```

`packages/policy` is pure and performs no DNS, HTTP, filesystem, database, or environment access. The API coordinates validated inputs, policy decisions, and tenant-scoped repositories; it cannot replace a policy denial. Database isolation remains effective even if an API ownership check is missing.

## Gate 1: foundation remediation

### Runtime and CI

- Declare Bun 1.4.0 as the repository package-manager/runtime version because `bun.lock` version 2 requires Bun 1.4.
- Install with `bun install --frozen-lockfile`; CI must reject lock drift.
- Add CI that runs workspace verification, correctly partitioned tests, strict type checking, lint, formatting, the web build, migration checks, and Docker Compose validation.
- The PostgreSQL integration job runs migrations and mandatory RLS tests against a PostgreSQL 16 service. It must not silently skip them.

### Test topology

- `unit`: `tests/unit`, API unit tests, and non-contract package unit tests.
- `contract`: `packages/contracts/test` and `tests/contract`.
- `integration`: `packages/db/test` and `tests/integration`.
- `isolation`: `tests/isolation`.
- `e2e`: `tests/e2e`; an empty suite remains visibly pending rather than being reported as a security pass.
- Root strict type checking includes `tests/**`.

### Existing review findings

- Remove the launch-time DNS-TXT authorization statement from `atlas.html`; the reserved enum value never authorizes execution.
- Remove the implicit database URL from Drizzle configuration. Migration commands require `DATABASE_URL` explicitly.
- Keep predictable credentials only inside an explicitly local Compose profile/template; application configuration has no credential fallback.
- Pin MinIO to an immutable release/digest rather than `latest`.
- Local hooks may skip when Bun is unavailable, but failures may not be swallowed when Bun is present. CI is the mandatory gate.
- Record generic PostgreSQL as the selected deployment boundary; Supabase-specific service roles are not part of this design.

## Gate 2: policy authority (T010-T013)

### Scope normalization

`packages/policy/src/scope.ts` exposes typed normalization and matching primitives:

- Web/API/GenAI inputs accept only `http:` and `https:` URLs. Userinfo and fragments are rejected. Hostnames are lowercased, IDNs converted to ASCII, trailing dots removed, paths normalized, and default ports removed.
- Surface inputs accept a hostname/domain, not an arbitrary URL. Internal targets are rejected by the external normalizer.
- IP literals are canonicalized before classification. The deny set includes unspecified, loopback, RFC1918, link-local, CGNAT, documentation/test ranges, benchmark ranges, multicast, reserved ranges, IPv6 ULA/link-local/multicast, and IPv4-mapped equivalents. Metadata hosts and addresses are explicitly denied.
- Domain names that resolve later are not trusted merely because their text looks public. Network-capable authorization requires a non-empty set of already resolved and connection-pinned addresses; any forbidden address denies the request. DNS resolution itself belongs to the future safe-fetch boundary.
- Inclusions and exclusions compile to canonical host/port/path rules. Exclusions always win. Wildcards are limited to a complete left-most subdomain label; substring and regex-style matching are forbidden.

### Entitlements

`packages/policy/src/entitlement.ts` returns immutable rights for `free_unverified`, `free_verified`, `pro`, and `lifetime`:

- `free_unverified`: passive public-posture slice and aggregate visibility only.
- `free_verified`: introductory slice and title/category/severity visibility only.
- `pro` and `lifetime`: detailed findings, paid reports, scheduling, and comparable history, matching FR-005. A later server catalog may reduce a purchased product's quota but cannot grant a capability forbidden by policy.
- Conservative per-assessment safety ceilings are 1 credit for free plans and 10 credits for paid plans. These are policy ceilings, not prices, balances, or commercial quotas. The later server-side catalog may reduce them but cannot raise them without a reviewed policy version change.

### Limit reduction

`packages/policy/src/limits.ts` validates positive integers and computes the minimum of playbook, entitlement, account, requested, and global limits for duration, concurrency, rate, and credits. Missing authoritative ceilings deny authorization; missing user-supplied limits cannot enlarge authority. Egress remains default-deny and cannot be widened by merging arrays.

### Authorization engine

`packages/policy/src/engine.ts` receives a discriminated action request plus normalized scope, entitlement, effective limits, verification facts, and the versioned playbook. It returns a structured decision with `allowed`, stable block codes, a human-safe reason, and the reduced limits/actions.

All applicable checks run so audit can record every block, but any block produces `allowed: false` and no executable action list. Active external authorization requires an HTTP-file verification fact and versioned authorization attestation. A `dns_txt` fact is always insufficient at launch. Unknown actions, ports, capabilities, plans, target categories, or missing context are denied.

## Gate 3: database isolation and audit (T014-T017)

### Schema organization

Drizzle schema modules live under `packages/db/schema/`, grouped by cohesive domain while re-exported from `index.ts`. They implement all entities in `data-model.md`: account, user, session, assessment, authorization attestation, verification, playbook, job, runner execution, credential, finding, report, credit entry, billing event, entitlement, agent, audit event, and notification.

Every tenant-owned row has a direct immutable `account_id`, including `session`. Catalog rows use explicit read-only policies. Foreign keys include the tenant key where needed to prevent cross-account references. Status values use PostgreSQL enums matching the contracts. Timestamps are `timestamptz`; UUID defaults use a version available in PostgreSQL 16 extensions and are generated consistently.

### Roles and RLS

- Owner/migration credentials are used only by the migration command.
- `api_rls`, `worker_rls`, and `reporting_rls` are `NOSUPERUSER NOBYPASSRLS NOINHERIT` runtime roles.
- Tenant policies use `current_setting('app.tenant', true)` and deny when it is absent, empty, malformed, or different from `account_id`.
- Tables use `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` where compatible with migration ownership.
- Runtime roles receive table/sequence privileges no broader than their responsibilities.
- Audit rows grant insert/select as needed but never update/delete to runtime roles.

OAuth needs identity before a tenant is known. A separate `auth_bootstrap` role has no direct table privileges and can execute only fixed-search-path security-definer functions for: resolving/creating one Google identity, resolving one valid session hash, rotating a session, and revoking it. Functions return the minimum identifiers/fields and never support arbitrary lookup or email-based linking.

### Tenant transaction wrapper

`packages/db/src/tenant-session.ts` starts a transaction, calls `set_config('app.tenant', accountId, true)`, applies one allow-listed local role, runs the callback, and always commits or rolls back before returning the connection. Role names cannot come from request text. Queries outside this wrapper have no tenant and are denied by RLS.

### Audit chain

The Zod audit contract remains in `packages/contracts`. Persistence belongs in `packages/db/src/audit.ts`.

Chains are per account to avoid global contention and cross-tenant linkage. Inserts take a transaction-scoped advisory lock derived from `account_id`, select the previous event, redact the payload before persistence, and insert the next link in the same transaction. System events with no account use a separate system chain. Security-critical mutations fail closed if their audit event cannot be committed atomically.

## Gate 4: secrets and passive playbook (T018-T019)

### External credential AEAD

`packages/secrets` exposes an envelope format containing version, algorithm, key ID, nonce, ciphertext, and authentication tag. Keys are obtained from an injected key provider by `key_id`; no environment lookup or default key exists inside the crypto module.

Encryption uses a fresh cryptographic nonce and binds account, assessment, credential ID, and purpose as additional authenticated data. Decryption requires the same context, supports key rotation, and returns generic errors without plaintext or key material. Tests cover tampering, wrong tenant/context, wrong key, unique nonces, and redaction-safe errors.

### Passive playbook catalog

`packages/playbooks` validates the existing versioned contract and exports `surface-public-posture@1.0.0`. It contains only the declared passive/minimal actions: DNS records, TLS certificate metadata, HTTP headers, `robots.txt`, `sitemap.xml`, and minimal public endpoint collection, all capped by the playbook limits.

This package catalogs and slices actions only. It performs no DNS/HTTP execution. Unknown action types or extra fields fail schema validation.

## Gate 5: API and Google OAuth (T020-T021)

### Hono application boundary

Refactor the current app into a `createApp(dependencies)` factory while preserving `GET /health` and the JSON 404 envelope. Routes live under `/api/v1`; middleware supplies a request ID, exact-origin credentialed CORS for auth endpoints, safe error mapping, session resolution, and an audit boundary.

Every mutation validates body/query/path schemas, authenticated ownership, state/entitlement when applicable, and policy before persistence. This phase exposes only auth routes and `/auth/me`; assessment routes remain absent.

### OAuth and sessions

- Use `openid-client` Authorization Code with PKCE S256, cryptographic `state`, nonce, and one exact configured redirect URI.
- Keep the transient PKCE verifier/state/nonce in a short-lived authenticated and encrypted HttpOnly cookie. Its signing/encryption key is mandatory configuration and is unrelated to provider/client secrets.
- The callback validates state, nonce, issuer, audience, code exchange, and subject. Identity is keyed only by immutable `(provider, provider_subject)`; email is display data and never links accounts.
- On first login, create account, user, session, and audit event atomically through the narrow bootstrap function. The absence of a Stripe-derived entitlement resolves to the non-purchased `free_unverified` baseline in policy; login never creates an entitlement row or credits.
- Session cookies contain a random opaque token. Only its SHA-256 hash is stored. Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, narrowly scoped, expiring, rotatable, and revocable.
- Insecure cookies are allowed only under an explicit local-development flag and are rejected in production configuration.
- `/auth/logout` is idempotent and revokes the current session. `/auth/me` returns only the current user/account public view and server-derived plan/AI-enabled state.
- GitHub and X remain modeled-disabled; requests for them return a stable unsupported-provider error.

OIDC network operations are behind a small adapter. Route/flow tests use a fake adapter and never contact Google; an optional manual smoke test may use real development credentials.

## Error handling and security behavior

- Domain errors have stable internal codes; responses expose only safe messages and optional field names.
- Invalid input is `400`, missing/invalid session is `401`, ownership/policy denial is `403`, state conflict is `409`, unavailable security dependencies are `503`, and unexpected errors are a generic `500` with request ID.
- OAuth errors clear transient cookies and never echo authorization codes, tokens, claims, verifier, state, nonce, provider bodies, or stack traces.
- Database errors roll back transactions. Missing tenant context, role mismatch, audit failure on mutation, absent crypto keys, or missing mandatory OAuth configuration fail closed.
- Logs and audit payloads pass through recursive redaction before write. Secret-bearing keys and known credential/token patterns are removed, not merely masked at presentation time.

## Test strategy and proof

### Pure tests

- Table-driven and property-style tests for URL/domain/IP canonicalization, inclusion/exclusion precedence, forbidden ranges, IPv4-mapped IPv6, metadata hosts, wildcard boundaries, unknown actions, DNS-TXT denial, and limit non-escalation.
- Entitlement visibility/capability matrix tests for every plan.
- AEAD round-trip and negative tests.
- Passive playbook schema, closed actions, slicing, and immutable limits.
- API error envelope, CORS, configuration failure, cookie attributes, PKCE/state/nonce, provider mismatch, logout idempotency, and secret-redaction tests.

### PostgreSQL integration/isolation tests

- Migration from empty PostgreSQL 16 and idempotent rerun.
- Assert runtime roles are non-owner, non-superuser, non-inheriting, and non-`BYPASSRLS`.
- With two accounts, prove A cannot select, insert, update, delete, reference, or infer B rows across representative tables and every access class.
- Prove missing/invalid tenant context denies access and a transaction cannot leak tenant/role state to the next borrower.
- Prove auth bootstrap functions expose only their intended operation and direct table access is denied.
- Prove audit chains remain ordered under concurrent inserts and runtime roles cannot mutate/delete history.

### Required final verification

```bash
bun install --frozen-lockfile
bun run verify:workspace
bun run test:unit
bun run test:contract
bun run test:integration
bun run test:isolation
bun run typecheck
bun run lint
bun run format
bun run --cwd apps/web build
docker compose -f infra/docker/compose.yml config
git diff --check
```

Database suites run with the documented PostgreSQL service and cannot be counted as passing when skipped. The empty future e2e suite is reported as pending, not green.

## Acceptance criteria

- All foundation-review medium and low findings in scope are resolved or explicitly superseded by a tested Phase 2 implementation.
- T010-T021 are implemented and checked in `tasks.md` only after their evidence is green.
- Policy decisions are pure, structured, default-deny, and cannot be enlarged by caller input.
- All tenant data is protected by tested PostgreSQL RLS under least-privileged runtime roles.
- OAuth provides Google-only PKCE sessions without email auto-linking or secret exposure.
- No code introduced by this increment can execute or contact an assessment target.
- Constitution checks II, III, V, and the relevant primitives of I/IV/VI remain satisfied.

## Autonomous decisions recorded

The user authorized autonomous execution and asked not to be interrupted for normal choices. Therefore this design selects the conservative values and decompositions above, resolves generic PostgreSQL versus Supabase in favor of the existing generic PostgreSQL architecture, and treats security ambiguity as deny-by-default. Only an external blocker requiring new credentials/authority would stop execution.
