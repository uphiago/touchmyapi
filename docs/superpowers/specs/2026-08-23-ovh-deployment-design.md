# OVH Deployment Design

**Date:** 2026-08-23  
**Status:** Approved by reference to Barbarossa  
**Reference:** `/home/hiago/repositories/red/infra/barbarossa/.github/workflows/build-deploy.yml`

## Outcome

TouchMyAPI will use the hardened Barbarossa release pattern, adapted to this Bun monorepo:

1. pull requests validate source, tests, builds, Docker Compose, and deployment invariants;
2. a manual dispatch or immutable `v*` tag builds application images and publishes both the commit SHA and release tag to GHCR;
3. deployment uses a GitHub `production` environment, verified OVH host key, dedicated SSH key, serialized concurrency, and immutable SHA image references;
4. reviewed runtime files are uploaded without overwriting the host-provisioned production environment;
5. database migrations run as a one-shot release step before application cutover;
6. the remote stack must become healthy and pass public/loopback smoke checks before the job succeeds.

No deployment occurs from pull requests or ordinary branch pushes.

## Alternatives considered

### Static frontend upload

This is simple but cannot deploy the API, worker-control, migrations, or separate admin origin. Rejected.

### Remote repository pull and build

This reduces registry work but gives the production host broad source/build responsibilities, makes releases slower, and weakens artifact immutability. Rejected.

### GHCR images plus reviewed runtime bundle

This matches Barbarossa, gives immutable artifacts and a small host-side cutover surface, and supports rollback by SHA. Selected.

## Release artifacts

Initial images:

- `ghcr.io/uphiago/touchmyapi-api`;
- `ghcr.io/uphiago/touchmyapi-web`;
- `ghcr.io/uphiago/touchmyapi-admin` after the separate admin application exists.

Worker-control is added as a separate image only when production dispatch is enabled. The current deploy must not expose an execution surface that the application has not implemented.

Every image is tagged with `${GITHUB_SHA}`. A tag-triggered release may also publish the Git tag. Deployment Compose always receives the SHA tag; `latest` is never a deployment authority.

## GitHub Actions boundary

The workflow uses actions pinned to full commit SHAs and minimal job permissions:

- validation: `contents: read`;
- image build: `contents: read`, `packages: write`;
- deployment: `contents: read`, GitHub `production` environment.

Deployment concurrency is `touchmyapi-production` with `cancel-in-progress: false`. Builds must complete before deploy. Secrets are referenced only in the deploy job and never written to logs or repository artifacts.

Required GitHub Environment secrets:

| Secret | Purpose |
| --- | --- |
| `OVH_HOST` | SSH host or IP |
| `OVH_USER` | dedicated non-root deploy user |
| `OVH_HOST_KEY` | reviewed `known_hosts` entry |
| `OVH_SSH_KEY` | dedicated private deployment key |
| `GHCR_PAT` | host-side read-only package token |

Application secrets and production database credentials are provisioned out of band in `$HOME/touchmyapi/shared/.env`. CI preserves this file and never uploads, prints, or synthesizes it. Missing required host configuration fails the deployment before cutover.

## OVH host layout

```text
$HOME/touchmyapi/
├── current/              # reviewed release runtime files
├── shared/
│   └── .env              # host-provisioned, mode 0600
└── releases/             # bounded release metadata / prior SHA
```

The deployment user requires only the Docker/Compose and directory permissions documented in the runbook. SSH password authentication and unverified host discovery are out of scope and must remain disabled. The workflow never uses `StrictHostKeyChecking=no` or `ssh-keyscan`.

## Runtime topology

- API and static web/admin containers run as non-root with read-only filesystems where supported.
- PostgreSQL uses a persistent named volume and is not published to a public interface.
- Application ports bind to loopback on the OVH host unless an existing reverse-proxy network is explicitly configured.
- Customer and admin public origins remain distinct.
- Health checks cover PostgreSQL readiness, API `/health`, and static application shells.
- Production local mocks are disabled and rejected by configuration validation.

TLS termination and DNS stay at the existing OVH reverse-proxy boundary. The repository documents the required customer/admin/API origins but does not mutate OVH DNS automatically.

## Cutover

1. Verify SSH host key and establish the dedicated connection.
2. Upload the Git archive into a temporary reviewed release directory.
3. Authenticate the OVH Docker client to GHCR through stdin.
4. Verify the host `.env`, Compose configuration, and referenced image SHA.
5. Pull the exact images.
6. Back up release metadata and run the migration one-shot container.
7. Start/recreate services with `docker compose up -d --remove-orphans --wait`.
8. Run remote loopback smoke tests and configured public health checks.
9. Mark the SHA as current and prune only old TouchMyAPI application images after success.

The deploy script must use explicit paths and project/image names. It must never recursively delete `$HOME`, the repository parent, unrelated Docker volumes, or unrelated images.

## Failure and rollback

- Validation/build failure prevents deployment.
- Migration failure prevents application cutover.
- Health/smoke failure makes the workflow fail and preserves the prior release SHA in metadata.
- Application rollback redeploys the prior immutable SHA. Database rollback is always a reviewed forward migration; destructive automatic down-migrations are forbidden.
- Logs included in GitHub Actions are bounded and must not include environment values, cookies, tokens, assessment targets, evidence, or credentials.

## Tests

- contract test parses the workflow and checks jobs, dependencies, event filters, pinned actions, environment, concurrency, host-key verification, and forbidden SSH patterns;
- Docker build tests build every image without production secrets;
- Compose config test uses a generated non-secret validation environment;
- deploy script syntax and regression tests prove explicit paths, immutable SHA use, environment preservation, bounded pruning, migration-before-cutover, and smoke-after-cutover;
- remote smoke script can be tested against local Compose before any OVH execution.

## Deferred external configuration

The repository can fully implement and validate the pipeline without the OVH/GitHub secrets. The first real deploy remains intentionally unavailable until the `production` environment, secrets, host directory, host `.env`, GHCR permissions, reverse-proxy routes, and DNS records are provisioned and reviewed.
