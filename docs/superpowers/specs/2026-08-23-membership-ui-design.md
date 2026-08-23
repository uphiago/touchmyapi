# T078 server-driven membership UI design

**Status:** Approved for implementation on `feat/foundation-phase2`.

## Goal

Give an authenticated customer a clear account/workspace control surface for
viewing available accounts, switching the active account, reviewing members,
creating invitations, and accepting an invitation. The browser renders server
decisions; it does not become an authorization authority.

## Boundaries

- `packages/ui/api-client.ts` owns the small, typed HTTP boundary. Requests use
  `credentials: "include"`, parse responses with existing contracts where
  available, and expose stable error information without leaking bearer tokens.
- `AccountSwitcher` consumes the server account list, marks the server-selected
  active account, and asks the server to switch. It never derives role access or
  account membership from local state.
- `Memberships` renders the server member list and conditionally displays
  actions only from server-provided capabilities. Conditional rendering is a UX
  optimization, not a security control.
- Invitation creation submits an email and role as JSON. Invitation acceptance
  submits `{ token }` as JSON to `/api/v1/invitations/accept`; the token is never
  put in a URL, query string, route state, document title, or rendered output.
- Loading, empty, network-error, and stable API-error states are explicit. A
  failed mutation does not optimistically change the active account or member
  list.

## Component shape

The existing Vite shell becomes a compact workspace view:

```text
App
└── WorkspacePanel
    ├── AccountSwitcher
    ├── Memberships
    │   ├── Member rows + role/status labels
    │   ├── Invite form
    │   └── Accept invitation form
    └── API status / error region
```

The visual direction is dark industrial operations UI: high-contrast text,
amber focus/accent states, restrained blue links, visible status badges, and
responsive single-column layout. No new UI framework or state manager is
introduced for this slice.

## Data flow

1. On mount, `App` requests the account list and renders the active account
   returned by the server.
2. Selecting another account calls the server switch endpoint with the target
   account ID. On success, the client replaces its account snapshot and reloads
   membership data; the rotated session remains an HTTP-only server concern.
3. Invite and accept forms submit JSON, show the server result, and refresh the
   relevant snapshot only after success.
4. All fetches are cancellable on unmount and do not retain credentials or raw
   invitation tokens in component state after submission.

## Verification

Component tests must prove:

- account list and active-account rendering;
- role/status labels come from the response;
- switch sends the target account to the server;
- invite and accept use JSON body requests;
- no invitation token is interpolated into a URL or rendered into the DOM;
- server errors and loading states are visible;
- no client-only role check grants access to a mutation.

The T078 gate is `bun run test:unit -- memberships` plus
`bun run --cwd apps/web build`, followed by the repository typecheck, lint, and
format checks.
