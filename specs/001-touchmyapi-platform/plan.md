# Implementation Plan: TouchMyAPI Platform

**Branch**: `001-touchmyapi-platform` | **Date**: 2026-08-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-touchmyapi-platform/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

TouchMyAPI is an authorized security-assessment platform. Users authenticate with Google, select an account/workspace through explicit membership, create assessments against clearly scoped external targets (and, later, internal environments via a private agent), and run versioned playbooks with hard limits enforced by a policy engine. A durable PostgreSQL queue drives isolated runner sandboxes; claims lock singleton `queue_global_state` then `queue_tenant_state` then jobs, use `SKIP LOCKED`, exact fairness, leases, monotonic fencing, heartbeat, retry/backoff, reaper, tenant/global limits, and a transactional at-least-once outbox with terminal failed/alert/audit behavior. Queue operations are exposed only through typed `packages/db/src/queue-control.ts` calls to fixed-signature definer functions; the connector has only `EXECUTE` and zero table grants. Plan gating controls what results, evidence, PDFs, and JSON the user may see; Stripe webhooks are the only source of truth for entitlement; DeepSeek and Codex act as non-executor AI (planner/triage and report drafting, respectively). A separate MFA-protected admin control plane provides policy-aware account-scoped queue operations through JIT grants without impersonation, RLS bypass, arbitrary SQL, secret/raw-evidence access, or billing writes. The build order is: foundation T010–T021, membership T071–T080, queue/outbox T081–T087, admin T088–T094, then existing assessment state tests T022 and later Stripe/playbook/verification/report/agent increments.

## Technical Context

**Language/Version**: Bun 1.x (API, control worker), TypeScript strict throughout; Vite + React 18/19 (web client)

**Primary Dependencies**: Hono on Bun, PostgreSQL driver (`postgres`/postgres.js for runtime queries under RLS; Drizzle ORM for schema/migrations), Stripe SDK + webhook signing, OAuth Google via Authorization Code + PKCE, Vitest (unit/contract/integration), React Router, zod for schema validation, motion (animations, per frontend design law)

**Storage**: PostgreSQL (source of truth + durable queue), private object storage (S3-compatible or GCS) for evidence and PDFs with signed temporary URLs

**Testing**: Vitest unit/contract/integration; RLS isolation tests; policy engine property tests; state-machine transition tests; webhook idempotency tests; quickstart.md validation run

**Target Platform**: Linux server (customer API, separate admin API, worker-control, runner sandbox via `SandboxProvider`); browser for web/admin clients; client-installed agent on customer Linux hosts

**Project Type**: web-service (web app + backend + worker + runner sandbox) monorepo

**Performance Goals**: single active execution per target/account, conservative global worker limits (small initial fleet), queue SDK-style durability (leased jobs survive worker restarts); no latency SLA beyond interactive dashboard

**Constraints**: policy engine is final authority; browser/model/runner cannot escalate limits; RLS default-deny; queue connector has only function `EXECUTE` and queue-control direct access is limited to operational queue state; credentials never in logs/reports/models/frontend; webhook-only entitlement changes; AI non-executor; no bucket public; one run per target/account

**Scale/Scope**: account/workspace tenants with explicit membership; Brazil/BRL, small curated playbook set; existing ~18 foundation tables plus membership, invitation, outbox, and admin tables; 1 customer API, 1 separate admin API/app, 1 control worker, 1 sandbox abstraction, 1 web app

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Authorized Assessments Only**: PASS - spec FR-004/FR-006/FR-014, attestation + HTTP verification gating designed into state machine.
- **II. Policy Engine Is the Final Authority**: PASS - spec FR-014/FR-015, `packages/policy` owns all scope/limit decisions; no bypass path.
- **III. Default-Deny Data Isolation**: PASS - spec FR-003/FR-020, RLS + `account_id` + runtime roles; isolation tests are acceptance criterion SC-002.
- **IV. Least Privilege for Runners and Credentials**: PASS - spec FR-009/FR-010/FR-012, signed TTL'd jobs, digest-pinned image, secret channel, private storage, `SandboxProvider`.
- **V. AI as Non-Executor**: PASS - spec FR-015/FR-016, DeepSeek/Codex output treated as untrusted data re-checked by policy engine; disable per account.
- **VI. Financial State Changes Only by Verified Webhook**: PASS - spec FR-006, idempotent signature-verified webhook; catalog server-side.
- **Phase 2A account isolation and queue/admin amendment**: PASS - spec FR-022–FR-027, constitution v1.1.2, explicit membership/RLS, least-privilege PostgreSQL queue-control boundary, fencing/outbox, and separate MFA admin origin with no bypass capabilities.

## Project Structure

### Documentation (this feature)

```text
specs/001-touchmyapi-platform/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Target Source Code (repository root)

This is the intended product structure. The current checkpoint contains `apps/api`, `apps/web`, `packages/contracts`, `packages/policy`, `packages/db`, the foundation schema/RLS migrations, and local PostgreSQL Compose infrastructure. The remaining paths are planned, not implemented.

```text
apps/
  web/                 # Vite + React: UI only, public keys (VITE_*)
  api/                 # Bun + Hono: sessions, membership, domain, billing API, reports gateway
  admin/               # Separate Bun + Hono admin origin/API; staff identity and MFA only
  worker-control/      # Bun: scheduler, policy dispatch, job leasing, reconciliation
  agent/               # Bun: client-side private agent (outbound, isolated local runner)
packages/
  db/                  # Drizzle schema, migrations, RLS bootstrap, runtime roles
  contracts/           # zod schemas: API, events, JSON export, webhook records
  policy/              # scope/entitlement/limits engine (pure, testable)
  playbooks/           # playbook contract schemas + curated playbook versions
  reporting/           # PDF composition + sanitization/redaction
  secrets/             # short-lived credential channel + encryption at rest ops
  runner/              # SandboxProvider interface + ephemeral container impl
  ui/                  # shared frontend components
infra/
  docker/              # runner image Dockerfile (digest-pinned), compose for local dev
tests/
  isolation/           # cross-account RLS + policy isolation tests
  e2e/                 # quickstart validation scenarios
```

**Structure Decision**: Bun monorepo with workspace packages; three trust boundaries: customer API/web, control worker/runner, and separate admin API/app. API/worker/admin share pure policy and contracts but use distinct identities, origins, cookies, and runtime roles. PostgreSQL remains both business source of truth and durable queue; transactional outbox plus polling provides delivery, with `LISTEN/NOTIFY` only as a hint. The runner remains behind `SandboxProvider` (ephemeral container implementation first). Apps stay thin; enforcement lives in `packages/policy` and `packages/contracts` to satisfy constitution principles II/III/IV/V/VI.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

Constitution Check passes; no complexity waivers required at this stage. Two deliberate design costs are tracked for visibility:

| Cost | Why It Is Accepted | Rejected Alternative |
|-----------|-------------------|----------------------|
| `packages/policy` as a shared engine vs. inline checks in API/worker | Needed so policy is the single authority enforced identically in API mutations and worker dispatch (constitution II) | Inline checks duplicated per app drift and allow browser/model escalation |
| `SandboxProvider` abstraction in V1 | Lets us ship an ephemeral container runner now and migrate to managed sandboxes (spec §5) without changing any domain code | Hard-wiring V1 to a specific sandbox vendor/language |
| Runner image + isolation from day one | Constitution IV requires least privilege even for the first passive playbook | Shipping scans without isolation then retrofitting a security boundary |
| Explicit membership, fenced PostgreSQL queue, and separate admin plane | Multi-user authorization and operational recovery require first-class tenant, fencing, and staff boundaries; each is tested and policy-limited | Implicit user ownership, Redis/Kafka broker, or admin owner/BYPASSRLS path would weaken default-deny isolation and auditability |

But these are design choices, not constitution violations, so the gate passes without recorded violations.
