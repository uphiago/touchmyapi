import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const read = (relativePath: string) => readFileSync(resolve(repositoryRoot, relativePath), "utf8");

describe("foundation configuration contracts", () => {
  it("does not present DNS TXT as an authorization or verification method", () => {
    const atlas = read("specs/001-touchmyapi-platform/atlas.html");

    expect(atlas).toContain("HTTP-file-only");
    expect(atlas).not.toMatch(/arquivo HTTP ou DNS TXT/i);
    expect(atlas).not.toMatch(/DNS[- ]TXT.*(?:autoriza|verifica)/i);
  });

  it("keeps migration failure and subprocess propagation fail-closed", () => {
    const migrate = read("packages/db/scripts/migrate.ts");

    expect(migrate).toContain('console.error("DATABASE_URL is required for migrations")');
    expect(migrate).toContain("process.exit(1)");
    expect(migrate).toContain(
      'cmd: ["bunx", "drizzle-kit", "migrate", "--config=drizzle.config.ts"]',
    );
    expect(migrate).toContain('"drizzle-kit", "migrate", "--config=drizzle.config.ts"');
    expect(migrate).toContain('cwd: new URL("../../../", import.meta.url).pathname');
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
    expect(testDatabaseInit).toMatch(/CREATE DATABASE touchmyapi_test;/i);
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
});

const dockerAvailable = typeof Bun !== "undefined" && Boolean(Bun.which("docker"));
const conditionalIt = dockerAvailable
  ? typeof it.runIf === "function"
    ? it.runIf(true)
    : it
  : typeof it.skipIf === "function"
    ? it.skipIf(true)
    : it.skip;

conditionalIt("validates both local Docker Compose configurations", () => {
  const composeFile = resolve(repositoryRoot, "infra/docker/compose.yml");
  const commands = [
    ["compose", "-f", composeFile, "config", "--quiet"],
    ["compose", "--profile", "local", "-f", composeFile, "config", "--quiet"],
  ];

  if (typeof Bun === "undefined") return;

  for (const args of commands) {
    const result = Bun.spawnSync({ cmd: ["docker", ...args], stderr: "pipe" });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode, stderr).toBe(0);
  }
});
