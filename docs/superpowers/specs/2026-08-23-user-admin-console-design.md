# User and Admin Console Design

**Date:** 2026-08-23  
**Status:** Approved  
**Scope:** T036, T078, T088–T094

## Outcome

TouchMyAPI will use an operational cockpit rather than a marketing-style dashboard. The customer console leads an authorized operator from workspace selection through assessment creation, queueing, and status review. The administrative control plane is a separate application and origin focused on service health, queue metadata, support grants, and read-only billing.

The interface must make the security boundary visible without turning implementation details into the primary experience. Local development remains useful without external credentials through explicit development-only server mocks. Production remains fail-closed wherever the staff identity, WebAuthn, JIT grant, billing, or queue-operation backends are not yet implemented.

## Design principles

1. The next permitted action is visually obvious.
2. Account, authorization, and execution state come from the server; browser state is never authority.
3. Customer and staff trust boundaries never share an application origin, session cookie, or local mock store.
4. Empty, loading, error, and unavailable states explain what the user can do next.
5. Operational density is moderate: compact enough for repeated use, calm enough for onboarding.
6. Local mocks are labeled and interactive, but cannot silently become production fallbacks.

## Visual direction

The visual language is a dark technical control room with editorial hierarchy:

- near-black green/graphite surfaces with thin structural rules;
- warm amber for primary action and authorization context;
- green, blue, amber, and red reserved for meaningful system states;
- editorial serif for short page titles and a clear sans-serif for interface copy;
- monospace for identifiers, timestamps, targets, queue positions, and audit references;
- restrained corners and shadows, avoiding nested rounded-card grids;
- subtle grid/scanline texture only in large background areas;
- reduced-motion support and visible keyboard focus.

The current oversized landing hero becomes an application shell. Desktop uses a persistent rail and compact top bar; mobile collapses navigation into a clear top-level control while preserving action order.

## Customer console

### Information architecture

- **Overview:** active workspace, plan/authorization context, assessment counts, queue status, recent activity, and the primary “New assessment” action.
- **Assessments:** filterable table/list with target, category, state, queue/execution metadata, and a contextual next action.
- **Team:** memberships, roles, invitations, and invitation acceptance. Mutation controls are shown only when the server-provided role permits them.
- **Workspace:** active-account switcher and safe session/account context.

Billing, findings, reports, notifications, and private agents may appear only as unavailable roadmap destinations until their server contracts are implemented. The UI must not fabricate production data or entitlement decisions.

### Assessment flow

Assessment creation is a guided drawer or modal:

1. category;
2. target;
3. scope;
4. limits and playbook summary;
5. authorization attestation;
6. review and save draft.

The local Phase 2 mock may resolve unavailable playbook/limit details to documented safe defaults on the server. The browser submits intent and displays the returned result. A draft can then be queued through an explicit review action. Status presentation follows the state machine and never implies that the local mock executed a real assessment.

### Assessment status

Each status has one primary explanation and permitted action:

| State | User meaning | Primary action |
| --- | --- | --- |
| `draft` | Configuration saved, not scheduled | Review and queue |
| `awaiting_verification` | Target control must be proven | View verification |
| `queued` | Accepted by the queue boundary | View queue details |
| `running` | A current fenced worker lease exists | View live status / cancel if policy permits |
| `analyzing` | Deterministic/AI triage is resolving artifacts | View progress |
| `completed` | Permitted results are available | View results |
| `failed` | Execution stopped with a safe reason | Review / retry if policy permits |
| `cancelled` | The run was stopped | Duplicate as a new draft |
| `stale_recovered` | Internal job recovery state | Presented to customers as queued/recovering |

## Administrative control plane

### Separation

The admin UI is created under `apps/admin` and runs at `http://127.0.0.1:5174` locally. Its API origin is distinct from the customer API. Staff cookies use a dedicated name and are never accepted by customer routes. Customer cookies are never accepted by admin routes.

The first local milestone may use a dedicated development-only admin API composition while T088–T092 remain incomplete. It must be mounted only when an explicit local-admin-mocks flag is enabled. Production composition returns unavailable for unimplemented staff operations.

### Information architecture

- **Operations:** API/worker/database health, queue depth, oldest-job age, and bounded alert summaries.
- **Accounts:** safe account identity and status lookup; no customer impersonation.
- **Queue:** metadata/status inspection and policy-aware cancel/requeue/reaper controls.
- **Access grants:** request, approval, expiry, ticket, reason, and capability status.
- **Billing:** entitlement and webhook-processing status, read-only.
- **Audit:** redacted staff action timeline and request identifiers.

Secrets, credentials, raw evidence, signed job payloads, arbitrary SQL, entitlement writes, credit grants, global reaping, target/scope mutation, and arbitrary runner dispatch have no UI or API surface.

### Local admin workflow

The server-side local mock supports an interactive demonstration:

1. establish a clearly labeled local staff session;
2. inspect operational summaries and safe account metadata;
3. request a capability grant with account, capability, ticket, reason, and TTL;
4. approve it as a distinct mock approver;
5. perform only the matching bounded queue action;
6. append and display a redacted mock admin audit entry.

This state resets when the local process restarts. The browser cannot directly activate a grant or mutate queue data without the mock API decision.

## Application behavior

### Loading and errors

- Initial navigation renders a stable shell and skeletons rather than an empty account selector.
- API health and authenticated workspace state are separate signals.
- Recoverable failures keep prior safe data visible and provide a retry action.
- Production-unavailable capabilities explain the missing backend boundary without suggesting that a browser setting can enable it.
- Development mode is identified by a persistent, non-alarming banner.

### Responsive behavior

- At wide widths, navigation rail and primary content share the viewport; data tables remain readable without horizontal card stacking.
- At tablet widths, summary metrics wrap and secondary details collapse.
- At phone widths, primary action, status, and next step appear before metadata; tables become labeled rows.
- Forms preserve label/control/error association and at least 44px pointer targets.

### Accessibility

- WCAG AA contrast for text and state indicators.
- Status is communicated by text and icon, never color alone.
- Keyboard navigation, focus return for dialogs, escape handling, and focus trapping are required.
- Live regions are limited to actionable success/error updates.
- Motion is non-essential and disabled by `prefers-reduced-motion`.

## Testing and verification

1. Component tests cover navigation, role-gated actions, loading/error/empty states, guided assessment validation, account switching, and invitation token clearing.
2. API tests prove local mocks are unavailable outside explicit development composition.
3. Contract tests prove customer/admin origins, cookies, and mock flags stay separate.
4. Local smoke proves CORS plus credential flow, customer draft-to-queue, admin staff bootstrap, grant approval, and one bounded mock queue operation.
5. Production builds are generated independently for customer and admin apps.
6. Headless browser captures at desktop and mobile sizes are reviewed for overflow, hierarchy, unavailable states, and truthful mock labeling.
7. Existing PostgreSQL integration and isolation suites remain green.

## Acceptance criteria

- A new local user can understand the active workspace, create an authorized assessment draft, queue it, and see the resulting state without reading implementation notes.
- Team and account switching are discoverable but do not compete with the assessment workflow.
- The admin app is visibly and technically separate from the customer console.
- A local staff user can demonstrate the complete grant-before-action flow; bypass attempts are denied.
- Missing external keys do not prevent the documented local journey.
- Production does not inherit local mock routes, credentials, grants, or fallback state.
- Desktop and mobile layouts have no clipped primary controls or unusable empty space.

## Deferred work

Real Google staff OIDC, WebAuthn registration/assertion, recovery reset approval, persistent admin schema/grants, production queue actions, Stripe-backed billing state, assessment execution, findings, reports, notifications, and private agents remain governed by their existing tasks and contracts. This design supplies their navigation and honest unavailable states; it does not mark those backends complete.
