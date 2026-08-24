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
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@(v\d+|main|master)\b/);
  });

  it("verifies SSH and never discovers or bypasses host keys", () => {
    const workflow = read(".github/workflows/build-deploy.yml");
    expect(workflow).toContain("OVH_HOST_KEY");
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    expect(workflow).toContain("--password-stdin");
    expect(workflow).not.toContain("ssh-keyscan");
    expect(workflow).not.toContain("StrictHostKeyChecking=no");
  });

  it("keeps production mocks off and runs migration before cutover and smoke", () => {
    const compose = read("infra/docker/compose.production.yml");
    const deploy = read("scripts/deploy-ovh.sh");
    expect(compose).toContain('LOCAL_MOCKS: "0"');
    expect(compose).toContain('LOCAL_ADMIN_MOCKS: "0"');
    const postgresService = compose.split("  postgres:")[1]?.split("\n  migrate:")[0] ?? "";
    expect(postgresService).not.toContain("ports:");
    expect(deploy.indexOf("run --rm migrate")).toBeLessThan(deploy.indexOf("up -d"));
    expect(deploy.indexOf("up -d")).toBeLessThan(deploy.indexOf("smoke-remote.sh"));
    expect(deploy).toContain("shared/.env");
    expect(deploy).toContain("^[0-9a-f]{40}$");
  });

  it("packages each application without repository secrets", () => {
    for (const path of ["apps/api/Dockerfile", "apps/web/Dockerfile", "apps/admin/Dockerfile"]) {
      const dockerfile = read(path);
      expect(dockerfile).toContain("oven/bun:1.4.0-slim");
      expect(dockerfile).toContain("USER bun");
      expect(dockerfile).not.toMatch(/COPY\s+\.env/);
    }
    expect(read(".dockerignore")).toContain(".env");
  });
});
