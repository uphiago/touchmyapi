# TouchMyAPI Interface Contracts

**Phase 1 output** | **Date**: 2026-08-17

Implemented, schema-validated definitions live in `packages/contracts` (zod). The current foundation implements assessment states, target categories, health, and error envelopes only. Job, playbook, export, webhook, and audit documents in this directory are versioned design references until their later implementation tasks are complete. Breaking changes bump the version and require migration handling.

Table of contents:

- [API contract](api.md) - REST endpoints for the web client
- [Playbook contract](playbook.md) - versioned playbook schema
- [Job contract](job.md) - signed runner job spec and artifact manifest
- [Export contract](export.md) - versioned JSON report / webhook / audit event shapes
