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
- **Alternatives considered**: Kysely (valid, less ORM ergonomics), a hand-managed PostgreSQL driver boundary (schema drift risk), an ORM without RLS awareness (breaks the default-deny guarantee).

## R3. Durable queue on plain PostgreSQL

- **Decision**: Implement a small leased-job layer over `postgres` (postgres.js) using `FOR UPDATE SKIP LOCKED` (lease), retry/backoff columns, unique dedupe keys, timeout and abandoned-job recovery; ~200-300 lines, owned by `worker-control`. Evaluate `pg-boss` only if the hand-rolled layer grows beyond one queue.
- **Rationale**: PostgreSQL is already the source of truth and the constitution/spec explicitly says Redis/Kafka are not prerequisites. `SKIP LOCKED` is the established correct pattern for Postgres-backed queues and avoids polling storms.
- **Alternatives considered**: `pg-boss` (mature but pulls in its own scheduling semantics and admin surface), graphile-worker (Node, not tuned for Bun), and going straight to Redis (out of scope for V1 per spec §10).

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

- **Decision**: Launch supports active external assessments only when an HTTP-file challenge can be completed on the target origin. Re-verification is required on scope changes, and challenge records expire after a short window. Non-HTTP-serving external targets remain ineligible for active execution at launch.
- **Rationale**: Constitution principle I explicitly requires completed HTTP verification before every active external test. A DNS TXT challenge may prove zone control, but accepting it as an execution gate would require a documented constitution amendment and migration plan first.
- **Future option (disabled)**: The data model may reserve `dns_txt` for a later, constitution-approved flow using a namespaced label such as `_tma-<service>-challenge.<domain>`, a >=128-bit random token, short expiry, and provider attribution. Until then it MUST NOT authorize execution.
- **Alternatives considered**: DNS TXT, CNAME challenge, registrar attestation, and manual audited verification. All remain disabled as execution gates at launch.

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

## R12. Multi-user account and identity boundary

- **Decision**: Keep the existing `user` table as the sole immutable global Google identity (`provider + provider_subject`), use `account` as the tenant/workspace, and authorize business data through `account_membership(account_id,user_id)` with `owner`, `admin`, `operator`, `viewer`, and `billing` roles. Multiple owners are allowed; a locked transaction rejects removing/demoting the last active owner. Invitations store a SHA-256 hash of a 256-bit bearer token; email is delivery only and never auto-links a user. Acceptance is an explicit redacted POST body and same-user replay is idempotent.
- **Rationale**: Membership is a first-class RLS and audit boundary, supports one user in multiple accounts, prevents email collisions, and avoids a second identity authority. The active account is `session.account_id`; narrow `auth_list_accounts` and `auth_switch_account` functions enumerate/switch safely and rotate sessions.
- **Alternatives considered**: a new `identity` table (dual authority and migration ambiguity), implicit `user.account_id` ownership (cannot safely model multiple memberships), email-based linking (account takeover risk), and a separate organization service (duplicate source of truth and policy boundary).

## R13. PostgreSQL queue fencing and exact fair scheduling

- **Decision**: Extend the existing PostgreSQL queue with `queue_tenant_state(account_id,last_dispatched_at,running_count,concurrency_limit)` for every active account. Account creation upserts it transactionally, migration backfills it, and a reconciler creates missing rows and repairs drift. Claim locks an eligible tenant with `FOR UPDATE SKIP LOCKED` ordered by `last_dispatched_at NULLS FIRST,account_id`, then its eligible `queued`/`stale_recovered` job ordered by `priority DESC,available_at,created_at,id`; it atomically increments running count/timestamp and monotonic fencing token. Missing/inconsistent state fails closed while jobs remain queued for reconciliation. `running` reaps to `stale_recovered` with backoff; next claim returns to `running`; exhausted attempts fail. Partial active uniqueness covers `queued`/`stale_recovered`/`running`. PostgreSQL remains source of truth; `LISTEN/NOTIFY` is only a wake-up hint.
- **Rationale**: Lease plus fencing prevents stale workers from committing after a lost lease; exact tenant row locking prevents noisy tenants monopolizing global capacity; polling/reaper survive notification/process failure. A transactional outbox makes state transitions and delivery intent atomic without Redis or Kafka.
- **Alternatives considered**: Redis/Kafka (new source of truth and delivery semantics), deficit/fair-score scheduling (unnecessarily vague), broker-only notifications (lost wake-ups), and an unfenced lease (stale completion race).

## R14. Transactional outbox delivery

- **Decision**: Insert account-scoped outbox rows in the same transaction as assessment/job state changes, unique by event key. Claim with `FOR UPDATE SKIP LOCKED`, short lease owner/expiry, monotonic fencing token, and heartbeat; recover expired processing rows to pending with bounded backoff. Deliver at least once with idempotent consumers. A poller is mandatory; `NOTIFY` may reduce latency but cannot acknowledge delivery.
- **Rationale**: The database commit is the only durable fact, so a crash cannot leave a state change without its event or an event without the state change. Idempotent keys make redelivery safe.
- **Alternatives considered**: synchronous external publish in the request transaction (availability coupling), notification-only delivery (loss on restart), and dual writes without a unique event key (duplicates).

## R15. Separate admin control plane

- **Decision**: Create a separate admin origin/API with `staff_identity`, `staff_mfa_factor`, `staff_session`, `staff_role_assignment`, `support_access_grant`, `support_access_approval`, and `admin_audit_event`; staff bootstrap is an out-of-band CLI/migration-owner operation by immutable Google Workspace subject, followed by separate Google OIDC and local WebAuthn MFA. Recovery is hash-only and MFA reset requires dual approval. Short-lived per-account grants require reason, ticket, TTL, and approval; break-glass requires two approvals. Admin has no impersonation, owner/BYPASSRLS, arbitrary SQL, secret/raw-evidence, or billing-write path.
- **Rationale**: A separate trust boundary limits blast radius and makes staff authentication and audit distinguishable from customer membership. JIT grants minimize standing access while preserving operational recovery.
- **Alternatives considered**: customer admin role (mixes trust domains), domain-only staff bootstrap (does not identify a person), impersonation (ambiguous actor/audit and secret exposure), and a privileged owner connection (violates Constitution III).

---

## Resolved unknowns

All technical context unknowns from the plan are resolved above. Key high-level decisions confirmed for Phase 1:

- UF/JS stack: Bun + Hono + React/Vite; Drizzle with RLS native support.
- Queue: Postgres `SKIP LOCKED` leases owned by worker-control.
- Stripe: raw-body constructEvent + dedupe-insert-before-side-effect.
- Google: openid-client PKCE.
- Runner: rootless Podman + gVisor runsc behind `SandboxProvider`, credentials via per-job tmpfs channel.
- Verification: HTTP-file required for every active external assessment; non-HTTP alternatives remain disabled pending a constitution amendment; SSRF-safe pinned fetch.
- AI: DeepSeek planner/triage + Codex reports, both non-executor, policy-reduced.
- Reports: react-pdf + sanitization layer; versioned JSON contract.
- Private agent: outbound WS to control worker with signed job specs.
- Multi-user: existing global `user` plus explicit membership/invitation, account-bound rotating session.
- Queue/admin: PostgreSQL fencing/outbox/exact tenant fairness and separate OIDC/WebAuthn MFA control plane with JIT grants.
