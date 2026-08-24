# Console, admin, and OVH checkpoint review

**Date:** 2026-08-23  
**Scope:** T095–T100  
**Result:** Accepted locally; first external OVH deployment remains provisioning-gated

## Delivered

- Customer operations cockpit with responsive Overview, Assessments, Team, and Workspace surfaces plus an authorization-first assessment wizard.
- Separate development-only staff API/application on ports `3001/5174`, `tma-admin-session`, exact CORS, server-owned mock state, distinct approval, bounded account/capability action, read-only billing, and redacted audit.
- Four-process local launcher and smoke proving customer draft → queued, admin grant → approval → simulation, and rejection of both cross-cookie directions.
- Three non-root Bun 1.4.0 images, static SPA server, production Compose with private PostgreSQL, loopback application ports, mocks disabled, read-only application filesystems, health checks, and one-shot migration.
- GitHub workflow adapted from Barbarossa: PR validation only; manual/`v*` releases; full-SHA actions; immutable GHCR SHA tags; minimal permissions; `production` environment; strict verified SSH; host `.env` preservation; serialized migration/cutover/smoke; bounded TouchMyAPI image pruning; current/previous SHA metadata.

## Verification evidence

- Fast aggregate: 36 files passed, 344 tests passed; 98 database/e2e cases were explicitly skipped in that non-DB invocation.
- PostgreSQL integration on `touchmyapi_checkpoint_integration_test`: 13 files, 79/79 tests passed.
- PostgreSQL isolation on `touchmyapi_checkpoint_isolation_test`: 5 files, 24/24 tests passed.
- TypeScript, ESLint, Prettier, workspace verification, shell syntax, deployment contracts, local/production Compose validation, API build, admin API build, customer build, and admin build passed.
- `bun run local:smoke` passed all customer/admin health, CORS/session, queue, approval, bounded-action, and cross-cookie checks while the stack was live.
- Desktop/mobile captures were inspected at `1440px` and `390px`; the admin mobile grid-row defect found during review was fixed and recaptured.
- `touchmyapi-api:test`, `touchmyapi-web:test`, and `touchmyapi-admin:test` built successfully from the pinned `oven/bun:1.4.0-slim` digest and ran as user `bun`.
- A disposable production Compose rehearsal ran the real migration, brought PostgreSQL/API/admin API/customer/admin healthy on alternate loopback ports, verified all shells/health endpoints, then removed its isolated volume/network.

## Security conclusions

The checkpoint adds no runner or target-contact path. Local assessment queueing is intent/state simulation only. Local staff grants reset with the process and cannot become a production fallback. Production staff health is available for operations, but all unimplemented staff capabilities return `503 admin_unavailable`. PostgreSQL remains unexposed in production Compose; application services bind only to loopback for the reviewed reverse-proxy boundary.

No impersonation, arbitrary SQL, raw evidence, signed job payload, credential, billing mutation, entitlement write, global reaper, target/scope mutation, or arbitrary runner dispatch route was added.

## Intentionally open

- T087: production assessment store, verification, and worker dispatch.
- T088–T094: persistent admin schema/RLS, real staff OIDC, WebAuthn/MFA/recovery, durable JIT/break-glass approvals, production support/billing reads, policy-aware PostgreSQL queue controls, and their full e2e review.
- First real OVH release: create/protect the GitHub `production` environment; provision `OVH_HOST`, `OVH_USER`, `OVH_HOST_KEY`, `OVH_SSH_KEY`, and `GHCR_PAT`; set public origin variables; provision `$HOME/touchmyapi/shared/.env`; and review reverse proxy, TLS, and DNS.

Those open items are not implied complete by T095–T100.
