# TouchMyAPI Interface Contracts

**Phase 1 output** | **Date**: 2026-08-17

Live, schema-validated definitions live in `packages/contracts` (zod). This directory is the versioned, human-readable reference. Every contract is versioned; breaking changes bump the version and require migration handling.

Table of contents:

- [API contract](api.md) - REST endpoints for the web client
- [Playbook contract](playbook.md) - versioned playbook schema
- [Job contract](job.md) - signed runner job spec and artifact manifest
- [Export contract](export.md) - versioned JSON report / webhook / audit event shapes