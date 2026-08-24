# OVH deployment runbook

TouchMyAPI publishes immutable commit-SHA images to GHCR and deploys them only from a manual workflow dispatch or a `v*` tag. Pull requests validate the source, all three production images, Compose, and deployment invariants; they cannot access the production environment.

## GitHub production environment

Create an environment named `production`, preferably with required reviewers, and add these secrets:

- `OVH_HOST`: reviewed host/IP;
- `OVH_USER`: dedicated non-root deploy user;
- `OVH_HOST_KEY`: reviewed complete `known_hosts` entry;
- `OVH_SSH_KEY`: dedicated deployment private key;
- `GHCR_PAT`: read-only package token used by Docker on the host.

Add repository/environment variables `CUSTOMER_API_ORIGIN` and `ADMIN_API_ORIGIN`. These are public browser build values, not secrets. A release build fails if either is absent.

The production repository currently uses:

| Variable | Value |
| --- | --- |
| `CUSTOMER_API_ORIGIN` | `https://api.touchmyapi.com` |
| `ADMIN_API_ORIGIN` | `https://admin-api.touchmyapi.com` |

## OVH host preparation

The deploy user needs Docker Compose access and ownership of `$HOME/touchmyapi`. Provision `$HOME/touchmyapi/shared/.env` out of band with mode `0600`; CI never uploads or prints it. At minimum it must define:

```dotenv
POSTGRES_DB=touchmyapi
POSTGRES_USER=touchmyapi
POSTGRES_PASSWORD=replace-me
DATABASE_URL=postgres://touchmyapi:replace-me@postgres:5432/touchmyapi
CUSTOMER_WEB_ORIGIN=https://app.example.com
ADMIN_WEB_ORIGIN=https://admin.example.com
```

The current OVH environment uses `https://app.touchmyapi.com` and
`https://admin.touchmyapi.com` for the two browser origins. Object-storage
credentials are stored only in the ignored local `.env` and the host file;
they are not uploaded by CI. The reserved private bucket name is
`touchmyapi-private`. R2 must be enabled in the Cloudflare account before the
bucket can be created or used.

Optional loopback ports default to customer API `3000`, admin API `3001`, customer web `8080`, and admin web `8081`. Configure the existing OVH reverse proxy and TLS/DNS separately. PostgreSQL has no host port.

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

The admin origin is deployable but its production staff capabilities deliberately return unavailable until real staff OIDC/WebAuthn/JIT persistence is implemented. `LOCAL_MOCKS` and `LOCAL_ADMIN_MOCKS` are hard-disabled in production Compose.

## Release and rollback

Run “Build and deploy TouchMyAPI” manually or push a reviewed `v*` tag. The job verifies the SSH host key, uploads the reviewed Git archive, logs Docker into GHCR through stdin, runs forward migrations, waits for health, and then records `current-sha` and `previous-sha` under `shared/releases`.

Application rollback uses a previously published 40-character SHA and the same script from that release directory. Database rollback is never automatic; use a reviewed forward migration. Do not replace `shared/.env`, discover host keys with `ssh-keyscan`, or bypass strict host verification.

The base/runtime approach follows the [official Bun container guidance](https://bun.sh/guides/ecosystem/docker) and [frozen-lockfile guidance](https://bun.sh/docs/pm/cli/install), while the workflow follows GitHub's [secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use) and pins all referenced actions to full commit SHAs.
