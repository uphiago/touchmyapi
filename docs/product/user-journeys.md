# Product journeys and delivery matrix

This document defines what each person sees, can do, and receives. PostgreSQL membership and the active server session are authoritative; navigation only reflects those decisions.

## Entry journey

1. A visitor lands on the public product page and sees the authorized-assessment workflow, security boundaries, and current login availability.
2. `GET /api/v1/auth/providers` controls the call to action. GitHub appears only when the OAuth App is configured. An empty provider list is a setup state, not a fake login button.
3. GitHub Authorization Code + PKCE creates or reuses the immutable `provider + provider_subject` identity, provisions an owner workspace on first login, stores only a session hash, and returns an HttpOnly cookie.
4. The server selects one active account. Switching validates membership and rotates the session.
5. A signed-in user with no active membership sees recovery and invitation acceptance, never invented account data.

## Account roles

| Role | Default views | Can change | Cannot access |
| --- | --- | --- | --- |
| `owner` | Overview, assessments, team, workspace | Assessments, invitations, member roles/status | Staff control plane; browser-side entitlement changes |
| `admin` | Overview, assessments, team, workspace | Assessments and non-owner team operations, subject to last-owner guard | Billing mutation; staff capabilities |
| `operator` | Overview, assessments, workspace | Create authorized drafts and confirm queueing | Team management; billing; policy/queue internals |
| `viewer` | Overview, assessments, workspace | Nothing account-sensitive | Create/queue, team, billing |
| `billing` | Overview, billing, workspace | Future purchase intent only | Assessments, findings, team, entitlement mutation |
| staff | Separate admin origin only | Bounded queue operations after MFA/JIT approval | Customer impersonation, secrets, raw evidence, arbitrary SQL, billing writes |

The credential-free local stack exposes five named workspaces so every customer role can be inspected. Its server still denies disallowed operations.

## Assessment journey

1. An owner, admin, or operator selects the supported passive public-surface category.
2. They enter the authorized target and explicit scope, review fixed limits and the versioned playbook, and accept `terms@1`.
3. Saving records a `draft` plus authorization attestation. It does not execute work.
4. A separate final review shows target, scope, playbook, authorization, and queue consequences.
5. The API rechecks membership, entitlement, DNS facts, playbook and policy. PostgreSQL atomically records the queued job and redacted outbox event.
6. The customer sees server-returned lifecycle state. A queue receipt never claims completion.
7. Worker execution, findings publication, notifications, PDF/JSON generation and signed downloads remain the next delivery milestone; local mode does not contact a target.

## Delivery by plan

The API/report boundary, not the browser, removes fields a plan cannot receive.

| Plan | Published customer delivery after completion |
| --- | --- |
| `free_unverified` | Passive public-posture aggregate only; no active testing, evidence, endpoint, reproduction, impact or remediation |
| `free_verified` / current UI label `verified` | Finding title, category and severity; detail remains blocked |
| `pro` / `lifetime` | Validated findings, redacted evidence, safe reproduction, impact, remediation, technical PDF, executive PDF, versioned JSON and comparable history |

The UI currently explains this contract but does not manufacture findings or reports before the worker/report milestones exist.

## Staff journey

The local staff console demonstrates the intended operator flow: observe safe health/queue metadata, search accounts, triage a queue item, request an account-scoped capability with ticket/reason/TTL, obtain distinct approval, execute one bounded simulation, and inspect the redacted audit event.

Production staff routes remain fail-closed until separate staff OIDC, WebAuthn MFA, persistent grants/approvals and the dedicated admin queue connector are completed. Customer cookies never authenticate to the staff origin.

## Honest unavailable states

- API unavailable: landing and console say the service is unavailable.
- OAuth provider absent: landing says provider setup is required.
- Signed in without a workspace: retry and invitation acceptance remain available.
- Invitation delivery adapter absent: creation fails before persistence; no undeliverable invitation is claimed.
- Runner/reporting absent: queued is shown as queued and delivery as pending, never completed.
- Production admin persistence/MFA absent: the admin API returns unavailable; local simulation is never enabled in production.
