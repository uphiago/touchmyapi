# OVH deployment runbook

TouchMyAPI publishes immutable commit-SHA images to GHCR and deploys them only from a manual workflow dispatch or a `v*` tag. Pull requests validate the source, API/web/admin/worker images, Compose, and deployment invariants; they cannot access the production environment.

## GitHub production environment

Create an environment named `production`, preferably with required reviewers, and add these secrets:

- `OVH_HOST`: reviewed host/IP;
- `OVH_USER`: dedicated non-root deploy user;
- `OVH_HOST_KEY`: reviewed complete `known_hosts` entry;
- `OVH_SSH_KEY`: dedicated deployment private key;
- `GHCR_PAT`: read-only package token used by Docker on the host.

Add repository variables `CUSTOMER_API_ORIGIN`, `ADMIN_API_ORIGIN`, `CUSTOMER_WEB_ORIGIN`, and `ADMIN_WEB_ORIGIN`. These are public origins, not secrets. A release fails before image publication if any is absent, and validates all four public `/health` endpoints after cutover.

Keep these four origins as reviewed GitHub variables only. Database URLs,
OAuth client secrets, encryption keys, Stripe keys, object-storage keys, and
runner credentials belong in the host-provisioned file below and are never
echoed by CI.

The production repository currently uses:

| Variable | Value |
| --- | --- |
| `CUSTOMER_API_ORIGIN` | `https://api.touchmyapi.com` |
| `ADMIN_API_ORIGIN` | `https://admin-api.touchmyapi.com` |
| `CUSTOMER_WEB_ORIGIN` | `https://app.touchmyapi.com` |
| `ADMIN_WEB_ORIGIN` | `https://admin.touchmyapi.com` |

## OVH host preparation

The deploy user needs Docker Compose access and ownership of `$HOME/touchmyapi`. Provision `$HOME/touchmyapi/shared/.env` out of band with mode `0600`; CI never uploads or prints it. At minimum it must define:

```dotenv
POSTGRES_DB=touchmyapi
POSTGRES_USER=touchmyapi
POSTGRES_PASSWORD=replace-me
DATABASE_URL=postgres://touchmyapi:replace-me@postgres:5432/touchmyapi
AUTH_DATABASE_URL=postgres://auth_connector:replace-with-distinct-password@postgres:5432/touchmyapi
API_DATABASE_URL=postgres://api_connector:replace-with-distinct-password@postgres:5432/touchmyapi
AUDIT_DATABASE_URL=postgres://audit_system_connector:replace-with-distinct-password@postgres:5432/touchmyapi
QUEUE_DATABASE_URL=postgres://queue_connector:replace-with-distinct-password@postgres:5432/touchmyapi
WORKER_DATABASE_URL=postgres://worker_connector:replace-with-distinct-password@postgres:5432/touchmyapi
REPORTING_DATABASE_URL=postgres://reporting_connector:replace-with-distinct-password@postgres:5432/touchmyapi
RUNNER_MODE=isolated
WORKER_ID=ovh-worker
CUSTOMER_WEB_ORIGIN=https://app.touchmyapi.com
ADMIN_WEB_ORIGIN=https://admin.touchmyapi.com
AUTH_PROVIDER=disabled
AUTH_TRANSIENT_KEY=base64url-encoded-32-byte-key
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
GITHUB_OAUTH_CALLBACK_URL=https://api.touchmyapi.com/api/v1/auth/github/callback
OBJECT_STORAGE_ENDPOINT=
OBJECT_STORAGE_BUCKET=touchmyapi-private
OBJECT_STORAGE_REGION=auto
OBJECT_STORAGE_ACCESS_KEY_ID=
OBJECT_STORAGE_SECRET_ACCESS_KEY=
```

Use different high-entropy passwords for the migration owner and every connector. The deploy runs migrations first, then configures `auth_connector`, `api_connector`, `audit_system_connector`, `queue_connector`, `worker_connector`, and `reporting_connector` from these URLs and verifies each login before cutover. The connector script never prints credentials.

`AUTH_PROVIDER=disabled` is the safe initial production state: the API, audit, landing and database runtime are available, while `/api/v1/auth/providers` returns no login provider. To enable sign-in, create a GitHub OAuth App with homepage `https://app.touchmyapi.com` and exact callback `https://api.touchmyapi.com/api/v1/auth/github/callback`, place its Client ID/Secret in the host file, and change `AUTH_PROVIDER=github`. Never enable `mock` in production.

The current OVH environment uses `https://app.touchmyapi.com` and
`https://admin.touchmyapi.com` for the two browser origins. Object-storage
credentials are stored only in the ignored local `.env` and the host file;
they are not uploaded by CI. The reserved private bucket name is
`touchmyapi-private`. R2 must be enabled in the Cloudflare account before the
bucket can be created or used.

Optional loopback ports default to customer API `3000`, admin API `3001`, customer web `8080`, and admin web `8081`. Configure the existing OVH reverse proxy and TLS/DNS separately. PostgreSQL has no host port.

The worker image is published as `ghcr.io/uphiago/touchmyapi-worker:<commit-sha>`
and is present in the production Compose contract, but it is under the
`execution` profile and is not started by the default deploy. In this branch
the isolated runner adapter is intentionally unavailable; `RUNNER_MODE=fixture`
is rejected for production and enabling the profile must remain blocked until
the sandbox, signed job capabilities, egress limits, cleanup, and evidence
redaction are reviewed. The worker has no Docker socket and receives only its
typed queue/worker connector URLs when that future profile is enabled.

The local worker path is intentionally different: `bun run dev:local` starts
the loopback MinIO service and `apps/worker-control` with `RUNNER_MODE=fixture`.
That fixture is development/test-only, performs no target network request, and
is the only supported end-to-end path for queue claim, deterministic passive
analysis, completion notification, and private report generation in this
checkpoint. It must never be enabled in the production Compose environment.

When the production execution profile is eventually enabled, all
`OBJECT_STORAGE_*` values must be supplied in the host-provisioned file and
must point to a private S3-compatible bucket. The customer API returns report
metadata only to an eligible account member; `free_unverified` receives
aggregate results, `free_verified` receives masked finding summaries, and
`pro`/`lifetime` may receive redacted evidence plus technical PDF, executive
PDF, and `report.json@1` downloads. Storage failure is fail-closed and does not
turn a queued or incomplete assessment into a completed one.

The observed OVH host has 2 vCPU, about 3.7 GiB RAM, cgroups available, and
approximately 2 GiB free on a 38 GiB root volume (95% used). The deploy script
fails closed when disk usage reaches 90% or more; reclaim space before any
production release.

## Production edge and DNS

Cloudflare is authoritative for `touchmyapi.com`. These DNS-only records point
to the reviewed OVH address; do not commit the Cloudflare API token or R2 keys:

| Host | Type | Destination |
| --- | --- | --- |
| `touchmyapi.com` | `A` | OVH |
| `www.touchmyapi.com` | `CNAME` | `app.touchmyapi.com` |
| `app.touchmyapi.com` | `A` | OVH customer web |
| `api.touchmyapi.com` | `A` | OVH customer API |
| `admin.touchmyapi.com` | `A` | OVH admin web |
| `admin-api.touchmyapi.com` | `A` | OVH admin API |

The independently provisioned Caddy edge lives under
`$HOME/touchmyapi-edge`. It is pinned by image digest, owns only host ports
`80` and `443`, obtains and renews public certificates, redirects the apex and
`www` to `app`, and proxies to the four loopback ports. UFW exposes only SSH,
HTTP, and HTTPS. Application Compose must continue binding its ports to
`127.0.0.1`; PostgreSQL remains unexposed.

Validate the public boundary after each release:

```bash
curl --fail --silent --show-error https://api.touchmyapi.com/health
curl --fail --silent --show-error https://admin-api.touchmyapi.com/health
curl --fail --silent --show-error https://app.touchmyapi.com/health
curl --fail --silent --show-error https://admin.touchmyapi.com/health
```

The admin origin is deployable but its production staff capabilities deliberately return unavailable until real staff OIDC/WebAuthn/JIT persistence is implemented. `LOCAL_MOCKS` and `LOCAL_ADMIN_MOCKS` are hard-disabled in production Compose. Customer login availability is independently visible through `/api/v1/auth/providers`.

## Release and rollback

Run “Build and deploy TouchMyAPI” manually or push a reviewed `v*` tag. The job verifies the SSH host key, uploads the reviewed Git archive, logs Docker into GHCR through stdin, runs forward migrations, configures/verifies least-privilege connector logins, waits for internal health, validates the four public edge endpoints, and then records `current-sha` and `previous-sha` under `shared/releases`.

Application rollback uses a previously published 40-character SHA and the same script from that release directory. Database rollback is never automatic; use a reviewed forward migration. Do not replace `shared/.env`, discover host keys with `ssh-keyscan`, or bypass strict host verification.

`scripts/rollback-ovh.sh` reads and validates `shared/releases/previous-sha`
and invokes the same immutable deploy path. It never edits the host secret
file, deletes broad paths, or rolls back database migrations. Deployment and
smoke scripts are validated locally only; no OVH command is run by CI
validation or this review.

The base/runtime approach follows the [official Bun container guidance](https://bun.sh/guides/ecosystem/docker) and [frozen-lockfile guidance](https://bun.sh/docs/pm/cli/install), while the workflow follows GitHub's [secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use) and pins all referenced actions to full commit SHAs.
