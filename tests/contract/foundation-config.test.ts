import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const read = (relativePath: string) => readFileSync(resolve(repositoryRoot, relativePath), "utf8");

describe("foundation configuration contracts", () => {
  it("does not present DNS TXT as an authorization or verification method", () => {
    const atlas = read("specs/001-touchmyapi-platform/atlas.html");

    expect(atlas).toContain("HTTP-file-only");
    expect(atlas).not.toMatch(/dns[\s_-]*txt/i);
  });

  it("keeps migration failure and subprocess propagation fail-closed", () => {
    const migrate = read("packages/db/scripts/migrate.ts");

    expect(migrate).toContain('console.error("DATABASE_URL is required for migrations")');
    expect(migrate).toContain("process.exit(1)");
    expect(migrate).toContain(
      'cmd: ["bunx", "drizzle-kit", "migrate", "--config=drizzle.config.ts"]',
    );
    expect(migrate).toContain('"drizzle-kit", "migrate", "--config=drizzle.config.ts"');
    expect(migrate).toContain('import { fileURLToPath } from "node:url"');
    expect(migrate).toContain('cwd: fileURLToPath(new URL("../../../", import.meta.url))');
    expect(migrate).not.toContain(".pathname");
    expect(migrate).toContain('stdin: "inherit"');
    expect(migrate).toContain('stdout: "inherit"');
    expect(migrate).toContain('stderr: "inherit"');
    expect(migrate).toContain("process.exit(await migration.exited)");
  });

  it("requires DATABASE_URL in the Drizzle configuration", () => {
    const drizzle = read("drizzle.config.ts");

    expect(drizzle).not.toContain("??");
    expect(drizzle).not.toMatch(/postgres(?:ql)?:\/\/[^\s"']+/);
    expect(drizzle).toContain("DATABASE_URL is required for migrations");
  });

  it("keeps the environment template free of database and real credentials", () => {
    const env = read(".env.example");

    expect(env).toMatch(/^DATABASE_URL=\s*$/m);
    expect(env).not.toMatch(/^DATABASE_URL=.+$/m);
    expect(env).toMatch(/^GOOGLE_CLIENT_ID=\s*$/m);
    expect(env).toMatch(/^GOOGLE_CLIENT_SECRET=\s*$/m);
    expect(env).toMatch(/^STRIPE_SECRET_KEY=\s*$/m);
    expect(env).toMatch(/^STRIPE_WEBHOOK_SECRET=\s*$/m);
    expect(env).toMatch(/^OBJECT_STORAGE_ACCESS_KEY_ID=\s*$/m);
    expect(env).toMatch(/^OBJECT_STORAGE_SECRET_ACCESS_KEY=\s*$/m);
  });

  it("pins local Compose services and leaves test database initialization explicit", () => {
    const compose = read("infra/docker/compose.yml");
    const testDatabaseInit = read("infra/docker/postgres/init/002_test_database.sql");

    expect(compose).toMatch(/postgres:\s*\n\s+image:\s+postgres:16\b/);
    expect(compose).not.toContain("minio/minio:latest");
    expect(compose).toContain(
      "minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
    );
    expect(compose).toMatch(/postgres:[\s\S]*?profiles:\s*\n\s+- local/);
    expect(compose).toMatch(/minio:[\s\S]*?profiles:\s*\n\s+- local/);
    expect(compose).toContain('"127.0.0.1:5433:5432"');
    expect(testDatabaseInit).toMatch(/SELECT\s+'CREATE DATABASE touchmyapi_test'/i);
    expect(testDatabaseInit).toMatch(/FROM\s+pg_database/i);
    expect(testDatabaseInit).toMatch(/datname\s*=\s*'touchmyapi_test'/i);
    expect(testDatabaseInit).toMatch(/\\gexec/);
    expect(testDatabaseInit).not.toMatch(/^CREATE DATABASE touchmyapi_test;/im);
  });

  it("preserves the foundation PostgreSQL extensions", () => {
    const extensions = read("infra/docker/postgres/init/001_extensions.sql");

    expect(extensions).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    expect(extensions).toContain("CREATE EXTENSION IF NOT EXISTS citext;");
  });

  it("keeps VITE variable names public and free of secret-shaped terms", () => {
    const env = read(".env.example");
    const viteNames = [...env.matchAll(/^((?:VITE_)[A-Z0-9_]+)=/gm)].map(([, name]) => name);
    const publicNames = [
      "VITE_API_BASE_URL",
      "VITE_GOOGLE_CLIENT_ID",
      "VITE_STRIPE_PUBLISHABLE_KEY",
    ];

    expect(viteNames).toEqual(expect.arrayContaining(publicNames));
    for (const name of viteNames) {
      expect(name).not.toMatch(/SECRET|PRIVATE|TOKEN|PASSWORD|WEBHOOK|ACCESS_KEY/);
    }
  });

  it("uses the same canonical loopback origins for Vite, API, and CORS", () => {
    const local = read("scripts/dev-local.ts");

    expect(local).toContain('const localWebOrigin = "http://127.0.0.1:5173";');
    expect(local).toContain('const localApiOrigin = "http://127.0.0.1:3000";');
    expect(local).toContain("CORS_ORIGIN: localWebOrigin");
    expect(local).toContain("VITE_API_BASE_URL: localApiOrigin");
    expect(local).toContain('["--host", "127.0.0.1", "--strictPort"]');
    expect(local).not.toContain('CORS_ORIGIN: "http://localhost:5173"');
    expect(local).toContain('const localAdminWebOrigin = "http://127.0.0.1:5174";');
    expect(local).toContain('const localAdminApiOrigin = "http://127.0.0.1:3001";');
    expect(local).toContain("ADMIN_CORS_ORIGIN: localAdminWebOrigin");
    expect(local).toContain("VITE_ADMIN_API_BASE_URL: localAdminApiOrigin");
    expect(local).toContain('LOCAL_ADMIN_MOCKS: "1"');
  });

  it("makes the local smoke prove the browser CORS and credential boundary", () => {
    const smoke = read("scripts/local-smoke.ts");

    expect(smoke).toContain('"http://127.0.0.1:3000"');
    expect(smoke).toContain('"http://127.0.0.1:5173"');
    expect(smoke).toContain("headers: { Origin: webBaseUrl }");
    expect(smoke).toContain('session.headers.get("access-control-allow-origin") !== webBaseUrl');
    expect(smoke).toContain('"http://127.0.0.1:3001"');
    expect(smoke).toContain('"http://127.0.0.1:5174"');
    expect(smoke).toContain("tma-admin-session");
    expect(smoke).toContain("customer cookie accepted by admin");
    expect(smoke).toContain("admin cookie accepted by customer");
  });

  it("keeps CI database gates on the test-only loopback contract", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toContain("@127.0.0.1:5432/touchmyapi_ci_integration_test");
    expect(workflow).toContain("@127.0.0.1:5432/touchmyapi_ci_isolation_test");
    expect(workflow).toContain("CREATE DATABASE touchmyapi_ci_integration_test");
    expect(workflow).toContain("CREATE DATABASE touchmyapi_ci_isolation_test");
    expect(workflow).not.toContain("@localhost:5432/touchmyapi_test");
    expect(workflow).toContain("bun run test:integration --maxWorkers=1");
    expect(workflow).toContain("bun run test:isolation --maxWorkers=1");
  });
});

const dockerAvailable = (() => {
  try {
    return spawnSync("docker", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

it.skipIf(!dockerAvailable)("validates both local Docker Compose configurations", () => {
  const composeFile = resolve(repositoryRoot, "infra/docker/compose.yml");
  const commands = [
    ["compose", "-f", composeFile, "config", "--quiet"],
    ["compose", "--profile", "local", "-f", composeFile, "config", "--quiet"],
  ];

  for (const args of commands) {
    const result = spawnSync("docker", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
  }
});
