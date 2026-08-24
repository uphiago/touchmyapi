# TouchMyAPI Interface Contracts

**Contract index** | **Updated**: 2026-08-22

Implemented, schema-validated definitions live in `packages/contracts/src` (Zod): assessment state/target, health/error, playbook, job, artifact manifest, export, billing event, audit event, and recursive redaction shapes. Their persistence/execution surfaces are separate milestones: the PostgreSQL schema exists, while the audit writer, passive playbook runtime, webhooks, queue, reports, and runner remain pending. Membership, queue, and admin contracts are approved Phase 2A design references (T071–T094), not implemented endpoints or tables. Breaking changes bump the contract version and require migration handling.

Table of contents:

- [API contract](api.md) - REST endpoints for the web client
- [Membership contract](membership.md) - account/workspace roles, invitation hashes, active-account sessions
- [Playbook contract](playbook.md) - versioned playbook schema
- [Job contract](job.md) - signed runner job spec and artifact manifest
- [Queue contract](queue.md) - PostgreSQL claim, fencing, lease recovery, fairness, and transactional outbox
- [Admin contract](admin.md) - staff MFA, JIT capability grants, dual break-glass, and policy-aware operations
- [Export contract](export.md) - versioned JSON report / webhook / audit event shapes
