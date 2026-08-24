import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("OVH release boundary", () => {
  it("builds immutable images and deploys only from dispatch or version tags", () => {
    const workflow = read(".github/workflows/build-deploy.yml");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("touchmyapi-production");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("${{ github.sha }}");
    expect(workflow).toContain("worker");
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@(v\d+|main|master)\b/);
    for (const variable of [
      "CUSTOMER_API_ORIGIN",
      "ADMIN_API_ORIGIN",
      "CUSTOMER_WEB_ORIGIN",
      "ADMIN_WEB_ORIGIN",
    ]) {
      expect(workflow).toContain(variable);
    }
    expect(workflow).toContain("Verify public edge after cutover");
    expect(workflow).toContain("curl --fail --silent --show-error --max-time 20");
  });

  it("verifies SSH and never discovers or bypasses host keys", () => {
    const workflow = read(".github/workflows/build-deploy.yml");
    expect(workflow).toContain("OVH_HOST_KEY");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).toContain("--password-stdin");
    expect(workflow).not.toContain("ssh-keyscan");
    expect(workflow).not.toContain("StrictHostKeyChecking=no");
  });

  it("uses the Node 24 Docker Buildx action release", () => {
    const workflow = read(".github/workflows/build-deploy.yml");
    expect(workflow).toContain(
      "docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e # v4.3.0",
    );
    expect(workflow).not.toContain("# v3.11.1");
  });

  it("keeps production mocks off and runs migration before cutover and smoke", () => {
    const compose = read("infra/docker/compose.production.yml");
    const deploy = read("scripts/deploy-ovh.sh");
    expect(compose).toContain('LOCAL_MOCKS: "0"');
    expect(compose).toContain('LOCAL_ADMIN_MOCKS: "0"');
    for (const variable of [
      "AUTH_DATABASE_URL",
      "API_DATABASE_URL",
      "AUDIT_DATABASE_URL",
      "QUEUE_DATABASE_URL",
      "WORKER_DATABASE_URL",
      "REPORTING_DATABASE_URL",
      "AUTH_TRANSIENT_KEY",
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "GITHUB_OAUTH_CALLBACK_URL",
    ]) {
      expect(compose).toContain(variable);
    }
    const postgresService = compose.split("  postgres:")[1]?.split("\n  migrate:")[0] ?? "";
    expect(postgresService).not.toContain("ports:");
    expect(deploy.indexOf("run --rm migrate")).toBeLessThan(
      deploy.indexOf("configure-connectors.ts"),
    );
    expect(deploy.indexOf("configure-connectors.ts")).toBeLessThan(deploy.indexOf("up -d"));
    expect(deploy.indexOf("up -d")).toBeLessThan(deploy.indexOf("smoke-remote.sh"));
    expect(deploy).toContain("shared/.env");
    expect(deploy).toContain("^[0-9a-f]{40}$");
    expect(deploy).toContain("insufficient disk headroom");
    expect(deploy).toContain("--profile execution pull worker");
    expect(deploy).toContain("touchmyapi-worker");
    expect(read("scripts/smoke-remote.sh")).toContain("/api/v1/auth/providers");
    expect(read("scripts/smoke-remote.sh")).toContain("unexpectedly running");
    expect(compose).toContain("profiles: [execution]");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).not.toContain("/var/run/docker.sock");
  });

  it("configures only fixed least-privilege login roles without logging secrets", () => {
    const connectorScript = read("packages/db/scripts/configure-connectors.ts");
    expect(connectorScript).toContain("auth_connector");
    expect(connectorScript).toContain("api_connector");
    expect(connectorScript).toContain("audit_system_connector");
    expect(connectorScript).toContain("queue_connector");
    expect(connectorScript).toContain("worker_connector");
    expect(connectorScript).toContain("reporting_connector");
    expect(connectorScript).toContain("ALTER ROLE");
    expect(connectorScript).not.toContain("console.log");
    expect(connectorScript).not.toMatch(
      /process\.env\.(POSTGRES_PASSWORD|AUTH_CONNECTOR_PASSWORD)/,
    );
  });

  it("packages each application without repository secrets", () => {
    for (const path of [
      "apps/api/Dockerfile",
      "apps/web/Dockerfile",
      "apps/admin/Dockerfile",
      "apps/worker-control/Dockerfile",
    ]) {
      const dockerfile = read(path);
      expect(dockerfile).toContain("oven/bun:1.4.0-slim");
      expect(dockerfile).toContain("USER bun");
      expect(dockerfile).not.toMatch(/COPY\s+\.env/);
    }
    expect(read(".dockerignore")).toContain(".env");
  });

  it("provides an immutable previous-release rollback without changing host secrets", () => {
    const rollback = read("scripts/rollback-ovh.sh");
    expect(rollback).toContain("previous-sha");
    expect(rollback).toContain("deploy-ovh.sh");
    expect(rollback).toMatch(/\[0-9a-f\]\{40\}/);
    expect(rollback).not.toMatch(/rm\s+-rf/);
  });
});
