# Public entrypoint and customer console review

Date: 2026-08-24

## Finding

The apex and `www` hosts previously returned a permanent redirect to
`app.touchmyapi.com`. That made the public product landing technically present
in the SPA but absent from the canonical public entrypoint, and it made the
boundary between a visitor and an authenticated customer unclear.

## Decision

- `touchmyapi.com` serves the public landing through the customer web loopback.
- `www.touchmyapi.com` permanently canonicalizes to `touchmyapi.com`.
- `app.touchmyapi.com` serves the customer console and is the post-login return
  host.
- `api.touchmyapi.com`, `admin.touchmyapi.com`, and `admin-api.touchmyapi.com`
  retain their separate boundaries.
- The SPA treats the apex and `www` as public hosts even if a browser already has
  a customer API session; the console is not rendered on the public entrypoint.

## Evidence

- `apps/web/src/public-host.test.tsx`: apex/`www` versus app/local host contract.
- `tests/contract/deployment.test.ts`: tracked Caddy routing and validated
  force-recreation with previous-config fallback.
- `infra/edge/Caddyfile`: source-of-truth edge routes shipped with the release.
- `scripts/deploy-edge-ovh.sh`: validates the candidate Caddyfile, recreates only
  Caddy to refresh the bind-mounted inode, and restores the previous file if the
  recreation fails.

## Remaining product prerequisite

The landing is available without credentials. GitHub sign-in remains visibly
unavailable in production until the GitHub OAuth App is created and its
host-only credentials are provisioned; this is intentionally not replaced by a
fake login button.
