# TouchMyAPI Interface Contracts

**Contract index** | **Updated**: 2026-08-23

Schema-validated definitions live in `packages/contracts/src` (Zod): assessment state/target, health/error, playbook, job, artifact manifest, export, billing event, audit event, and recursive redaction shapes. PostgreSQL membership, session, passive assessment draft/list, queue/outbox primitives, audit persistence, local fixture delivery, terminal findings/notifications and plan-filtered report metadata are implemented. GitHub customer OAuth and the role-aware workspace API are composed in production. Production worker execution/private storage, Stripe webhook entitlement, private-agent execution, and persistent staff OIDC/WebAuthn/JIT remain later milestones. Breaking changes bump the contract version and require migration handling.

Table of contents:

- [API contract](api.md) - REST endpoints for the web client
- [Membership contract](membership.md) - account/workspace roles, invitation hashes, active-account sessions
- [Playbook contract](playbook.md) - versioned playbook schema
- [Job contract](job.md) - signed runner job spec and artifact manifest
- [Queue contract](queue.md) - PostgreSQL claim, fencing, lease recovery, fairness, and transactional outbox
- [Admin contract](admin.md) - staff MFA, JIT capability grants, dual break-glass, and policy-aware operations
- [Export contract](export.md) - versioned JSON report / webhook / audit event shapes
