# T020 API Boundary Acceptance

**Date:** 2026-08-23  
**Branch:** `feat/foundation-phase2`  
**Commits:** `aab7642..1e91b64`  
**Status:** Accepted

## Delivered boundary

- `createApp(dependencies)` is a listener-free Hono factory with typed config, logger, and audit sink dependencies; only `server.ts` calls `Bun.serve`.
- `/health` remains public with exact-origin CORS and no credentials; future `/api/v1/auth/*` uses exact-origin credentialed CORS. Auth preflights are audited exactly once.
- Every `/api/v1/*` request receives a server-owned request ID and a fixed redaction-safe audit payload. Audit runs before route execution; mutation requests fail closed with `503 audit_unavailable` when the sink is unavailable. The executable default uses an unavailable sink rather than silently discarding audit records.
- Error handling maps typed API errors to stable `400/401/403/409/503` envelopes and maps unexpected failures to a generic `500`; no assessment, job, or execution routes exist.

## Review outcome

The specification review and adversarial quality review both returned `Ready: Yes` with no remaining findings. The final hardening includes duplicate-middleware removal, secret-bearing path exclusion, server-owned correlation IDs, mutation preflight, and CORS-preflight coverage.

## Verification

- API-focused tests: **13/13 passed**
- Full unit suite: **240/240 passed**
- Contract suite: **29/29 passed**
- `bun run typecheck`: passed
- `bun run lint`: passed
- `bun run format`: passed
- `git diff --check`: passed

T021 remains pending; this acceptance does not add OAuth, assessment execution, or external target access.
