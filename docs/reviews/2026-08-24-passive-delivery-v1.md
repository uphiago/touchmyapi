# Passive delivery v1 review

Date: 2026-08-24

## Accepted local slice

- PostgreSQL fair claim, heartbeat, fencing and terminal outbox flow are used by a
  standalone worker process.
- The development fixture produces bounded passive observations without target
  network access. Deterministic analysis publishes idempotent findings and one
  terminal notification.
- Customer delivery is reduced server-side to aggregate, masked or detailed data
  from the active membership and entitlement plan.
- Eligible `pro` and `lifetime` accounts receive private technical PDF, executive
  PDF and canonical `report.json@1` objects. The API exposes only a 60-second
  presigned download URL and never returns an object key or storage credential.
- The console polls non-terminal assessments, discards stale account requests,
  supports notification reads and renders report downloads. Owner, viewer and
  billing browser walkthroughs preserved their distinct navigation boundaries.
- `bun run dev:local` starts PostgreSQL, MinIO, API, worker, customer web and the
  separate admin surface. `bun run local:smoke` proved draft → queued → completed
  → detailed delivery → three private downloads plus the bounded admin flow.

## Security evidence

- Fresh integration database: 21 files / 94 tests passed.
- Fresh isolation database: 5 files / 26 tests passed.
- Fast Vitest gate: 50 files passed, 398 tests passed; database suites were
  separately exercised above rather than counted while skipped.
- TypeScript, ESLint, Prettier, workspace verification, customer/admin/API/worker
  builds, production Compose validation and worker image build passed.
- Delivery integration proves current-fence publication, stale-fence no-op,
  retry idempotency, deterministic report uniqueness and tenant isolation.
- The tracked diff contains no supplied Cloudflare token or R2 credential; `.env`
  remains ignored.

## Production boundary

GitHub Actions builds and publishes the worker image, and production Compose keeps
it under the explicit `execution` profile. The default OVH deploy pulls but does
not start it. `RUNNER_MODE=fixture` is rejected in production, the worker has no
Docker socket, and the deploy fails when host disk usage is at least 90%.

T106 therefore remains open for external target execution. Completion still
requires the reviewed isolated runner, signed job capability, redirect/DNS
rebinding controls, egress limits, cleanup evidence, enabled private production
storage and a post-deploy execution smoke. Until then production may accept and
queue an authorized passive draft, but it must not claim that the assessment ran.
