<!-- SPECKIT START -->
Project: TouchMyAPI - platform of authorized security assessments (assessments de segurança autorizados).

Read these artifacts for context before work:
- Plan: `specs/001-touchmyapi-platform/plan.md` (architecture decisions)
- Spec: `specs/001-touchmyapi-platform/spec.md` (requirements, user stories, acceptance criteria)
- Research: `specs/001-touchmyapi-platform/research.md` (tooling decisions)
- Data model + contracts: `specs/001-touchmyapi-platform/` (data-model.md, contracts/, quickstart.md)
- Constitution: `.specify/memory/constitution.md` (binding project principles; policy engine authority, default-deny isolation, least-privilege runner, AI non-executor, webhook-only billing)

Build order (from spec): auth + data isolation + state machine + queue + visualization first; then Stripe and a passive controlled playbook; then HTTP verification, active limited execution, reports, and the private agent.
<!-- SPECKIT END -->