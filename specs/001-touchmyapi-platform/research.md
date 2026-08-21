# Research: TouchMyAPI Platform

**Phase 0 output** | **Date**: 2026-08-17

Consolidates findings that resolve the technical unknowns in the implementation plan. Each item follows: Decision / Rationale / Alternatives considered.

---

## R1. Bun HTTP framework

- **Decision**: Hono on `Bun.serve` for the API app.
- **Rationale**: Actively maintained, Bun-native, first-party support for cookie sessions and route typing, and smaller surface than a full framework. Elysia is a valid contender with strong typing, but Hono's wider ecosystem and middleware for sessions/OAuth and zod body validation reduce integration risk.
- **Alternatives considered**: Elysia (close second, heavier DX assumption), plain `Bun.serve` (too low-level for the API surface; fine for the control worker internals).

## R2. Database tooling with RLS

- **Decision**: Drizzle ORM + `drizzle-kit` with native `pgPolicy`/`pgRole` support, app connects as an RLS-limited runtime role; each query wrapped in a `set_config` (app.tenant) + `set local role` transaction.
- **Rationale**: Drizzle gives typed schema/migrations and now models RLS policies and roles as part of the migration, so isolation is versioned with the schema, not bolted on in ad-hoc SQL. The app never connects as owner or an RLS-bypass role (constitution III).
- **Alternatives considered**: Kysely (valid, less ORM ergonomics), raw node-postgres everywhere (schema drift risk; migrations would be hand-managed), an ORM without RLS awareness (breaks the default-deny guarantee).

## R3. Durable queue on plain PostgreSQL

- **Decision**: Implement a small leased-job layer over `node-postgres` using `FOR UPDATE SKIP LOCKED` (lease), retry/backoff columns, unique dedupe keys, timeout and abandoned-job recovery; ~200-300 lines, owned by `worker-control`. Evaluate `pg-boss` only if the hand-rolled layer grows beyond one queue.
- **Rationale**: PostgreSQL is already the source of truth and the constitution/spec explicitly says Redis/Kafka are not prerequisites. `SKIP LOCKED` is the established correct pattern for Postgres-backed queues and avoids polling storms.
- **Alternatives considered**: `pg-boss` (mature but pulls in its own scheduling semantics and admin surface), graphile-worker (Node, not tuned for Bun), going straight to Redis (out of scope for V1 per spec §10).

## R4. Stripe webhook handling

- **Decision**: Official Stripe SDK; raw `ArrayBuffer` body → `stripe.webhooks.constructEvent` (verify signature first, then parse); **dedupe insert** (`INSERT ... ON CONFLICT DO NOTHING` keyed on Stripe event id) **before any side effect**; enqueue side effects and return 200 promptly.
- **Rationale**: Signature verification must happen against the raw body (SDK handles this); the unique-constraint-then-queue pattern makes re-delivery harmless and is idempotent by construction (constitution VI). Processing result and event version are stored for audit.
- **Alternatives considered**: Process-fully-before-ack (slow, prone to timeout), trusting a flag (idempotency-by-intent fails under exactly-once pressure).

## R5. Google OAuth Authorization Code + PKCE

- **Decision**: `openid-client` (certified, Bun-supported, actively maintained) for the Google PKCE flow; rotate and revoke HttpOnly secure SameSite cookies server-side.
- **Rationale**: `arctic` was deprecated by its author in 2026; `openid-client` is certified and maintained, and handles `state`, `nonce`, and exact redirect URI validation with minimal code.
- **Alternatives considered**: `arctic` (deprecated in 2026 - avoid), hand-rolled calls against Google's documented endpoints (zero-dep but reimplements state/nonce/validation that a certified lib already covers).

## R6. Runner isolation - no host Docker socket exposure

- **Decision**: A dedicated worker process (never the web/API tier) drives **rootless Podman** over a `podman.socket` bound to the worker's UID, running **one ephemeral container per job** with gVisor `runsc` as the OCI runtime. Image pinned by digest, non-root user, read-only rootfs, tmpfs workdir (`noexec,nosuid`), `--cap-drop ALL`, `no-new-privileges`, seccomp `RuntimeDefault`, CPU/memory/duration limits, `--rm` plus a watchdog forced-removal.
- **Rationale**: Rootless Podman removes the root daemon (the classic socket-escape path); no podman/Docker socket is ever mounted into or proxied for the API app (constitution IV). gVisor `runsc` gives near-VM syscall isolation at ~10-20% overhead - cheap insurance for V1. The worker ships a per-job channel token just in time, so no long-lived credential is pre-provisioned.
- **Credentials**: container starts network-bound; its entrypoint does an outbound pull from the worker's control channel, writes secrets to the tmpfs as a mode-0600 file owned by the non-root UID, and `rm`s on exit. Nothing in env vars or argv (both leak into `/proc` and logs). The tmpfs dies with the container.
- **Alternatives considered**: Docker daemon + socket proxy (second option; daemon stays root), dedicated runner host (stronger isolation, added ops cost), Firecracker/Kata microVMs (strongest, 30-120s cold start - overkill for a passive V1). Abstracted behind `SandboxProvider` so the worker can later move to a dedicated runner host or Kata without API changes.

## R7. Proof-of-control verification for non-HTTP targets

- **Decision**: Two-tier rule, validated server-side:
  - **HTTP-file verification required** when a public web origin is reachable (web-admin rights are stronger proof than DNS).
  - **DNS TXT proof accepted** when the target is non-HTTP-serving (bare IPs, APIs, GraphQL): namespaced challenge label `_tma-<service>-challenge.<domain>` with a >=128-bit random token, short expiry, provider-attributed so a user cannot certify a third-party service.
  - Re-verification required on scope changes; records expire after a short window.
- **Rationale**: DNS TXT proves authoritative control of the zone independent of web serving - the correct primitive for API/GraphQL/IP targets where a writable web root does not exist. Keeps abuse resistance: world-readable web origins still require the file, preventing "borrowed subdomain" attacks.
- **Alternatives considered**: CNAME challenge (only when TXT impossible), DomainAttest-style registrar attestation (still emerging, not for IP targets), manual support-case verification (audited fallback only).

## R8. SSRF-safe verification fetch

- **Decision**: Concrete safe-fetch policy for the server side that fetches the user-supplied verification file:
  1. `http:`/`https:` only; IP-literal hosts checked directly.
  2. Resolve via `lookup(..., { all: true })`; reject if **any** address is loopback, RFC1918, link-local (169.254/16, fe80::/10), CGNAT 100.64/10, ULA, multicast, or IPv4-mapped equivalents.
  3. **Pin the connection to the validated IP at TCP connect time** (custom `lookup` dispatcher on the fetch client) - defeats DNS rebinding (pre-check-then-fetch is TOCTOU).
  4. `redirect: 'manual'`; follow <=3 hops, re-validating each; refuse cross-host redirects; strip auth/body on redirect.
  5. Timeout <=5s, response-size capped, TLS verified, echo nothing back except "token ok".
- **Rationale**: Verification fetch is itself an SSRF surface; a naive fetch of a user-supplied URL is how internal metadata endpoints leak. Pinning the connection to the validated IP is the key defense.
- **Alternatives considered**: one-shot pre-check (vulnerable to rebinding), blocking by header heuristics (incomplete), running fetch inside the runner sandbox (overkill for a token check).

## R9. AI providers (planner/triage, report drafting)

- **Decision**: DeepSeek = structured planner/triage only, sanitized input, output treated as untrusted data passed back through `packages/policy` (reduce or reject before creating a job). Codex = report drafting from validated redacted findings only. Neither has tool access, credentials, arbitrary network, or raw private data (constitution V). External AI use logged per assessment; design a per-account disable flag now (no UI in V1).
- **Rationale**: Matches spec §6.5 and the 2026 GenAI/Agentic/OWASP guidance the product spec was built on: separation of identity, least privilege, policy enforcement, human-in-the-loop, and defense against prompt injection / tool abuse / poisoning / leakage.
- **Alternatives considered**: single-model-does-everything (rejected: merges planner and executor, increases abuse surface), no AI at all (weaker planning and reports; the product spec explicitly wants structured triage).

## R10. Reporting and PDF composition

- **Decision**: PDF generation via `@react-pdf/renderer` (Bun-compatible, React-based composition) plus a sanitization/redaction layer in `packages/reporting` that removes evidence, credentials, and blocks details not permitted by the entitlement before composition. JSON export uses the versioned schema in `packages/contracts`.
- **Rationale**: `@react-pdf/renderer` fits the React/Vite stack and lets the same team own UI and report layout. Sanitization runs before composition so no disallowed detail can reach a PDF (defense at render boundary, not presentation).
- **Alternatives considered**: Puppeteer/headless-chrome PDF (heavier runtime, harder in sandboxed CI), LaTeX (ops burden), plain template hand-rolling (slop-prone layout).

## R11. Private agent and control channel

- **Decision**: Agent app (`apps/agent`) is a Bun process installed by the customer: it establishes an outbound HTTPS/WebSocket connection to the control worker, owns a unique revocable identity (token + fingerprint), receives signed expiring job specs, executes locally through the same `SandboxProvider` interface in a local isolated runner, returns permitted artifacts, and never transmits secret material. Server never opens an inbound connection to the customer network.
- **Rationale**: Matches spec §7. Internal credentials live only in the agent environment. Client-initiated connection avoids inbound firewall openings and NAT port-forwarding requirements.
- **Alternatives considered**: inbound SSH/tunnel (requires inbound exposure), VPN appliance (heavy ops), agent-as-pull-poll (works but loses real-time dispatch; WS-protocol is acceptable and covers the spec's "canal autenticado").

---

## Resolved unknowns

All technical context unknowns from the plan are resolved above. No `NEEDS CLARIFICATION` remains. Key high-level decisions confirmed for Phase 1:

- UF/JS stack: Bun + Hono + React/Vite; Drizzle with RLS native support.
- Queue: Postgres `SKIP LOCKED` leases owned by worker-control.
- Stripe: raw-body constructEvent + dedupe-insert-before-side-effect.
- Google: openid-client PKCE.
- Runner: rootless Podman + gVisor runsc behind `SandboxProvider`, credentials via per-job tmpfs channel.
- Verification: HTTP-file required for web-reachable; DNS TXT for non-HTTP targets; SSRF-safe pinned fetch.
- AI: DeepSeek planner/triage + Codex reports, both non-executor, policy-reduced.
- Reports: react-pdf + sanitization layer; versioned JSON contract.
- Private agent: outbound WS to control worker with signed job specs.