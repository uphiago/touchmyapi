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

Optional loopback ports default to customer API `3000`, admin API `3001`, customer web `8080`, and admin web `8081`. Configure the existing OVH reverse proxy and TLS/DNS separately. PostgreSQL has no host port.

The admin origin is deployable but its production staff capabilities deliberately return unavailable until real staff OIDC/WebAuthn/JIT persistence is implemented. `LOCAL_MOCKS` and `LOCAL_ADMIN_MOCKS` are hard-disabled in production Compose.

## Release and rollback

Run “Build and deploy TouchMyAPI” manually or push a reviewed `v*` tag. The job verifies the SSH host key, uploads the reviewed Git archive, logs Docker into GHCR through stdin, runs forward migrations, waits for health, and then records `current-sha` and `previous-sha` under `shared/releases`.

Application rollback uses a previously published 40-character SHA and the same script from that release directory. Database rollback is never automatic; use a reviewed forward migration. Do not replace `shared/.env`, discover host keys with `ssh-keyscan`, or bypass strict host verification.

The base/runtime approach follows the official Bun container guidance (`oven/bun`, frozen lockfile, non-root runtime), while the workflow pins all referenced actions to full commit SHAs.
