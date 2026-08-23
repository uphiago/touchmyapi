# Assessment-to-queue integration checkpoint

The local development journey now exposes the first user-visible queue flow:

1. the server session selects an active account;
2. the account can create a bounded assessment draft;
3. the draft can be explicitly queued;
4. the UI refreshes from the server and shows `draft` or `queued` state.

The route boundary is account-scoped and checks the active session before every
list/create/queue operation. Inputs are contract-validated and targets are
never accepted from browser account state. The local composition uses an
in-memory mock store intentionally, so the flow works without external OAuth,
Stripe, or runner credentials.

Evidence:

- `apps/api/test/local-development.test.ts`: local session → assessment draft → queued, 2/2 tests.
- `packages/contracts/test/assessment.test.ts`: bounded create request normalization.
- `bun run typecheck` and `bun run --cwd apps/web build`: passed.
- Live smoke against `http://localhost:3000` created and queued
  `local.example.test` successfully.

The production store adapter still needs to connect assessment creation and
queueing to the PostgreSQL transaction boundary (`packages/db/src/queue.ts`)
and the authorization/verification state machine. That remains T027/T029/T087;
the mock is deliberately open only in `LOCAL_MOCKS=1` development mode.
