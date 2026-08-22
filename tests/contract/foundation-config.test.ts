import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const read = (relativePath: string) => readFileSync(resolve(repositoryRoot, relativePath), "utf8");

describe("foundation configuration contracts", () => {
  it("does not present DNS TXT as an authorization or verification method", () => {
    const atlas = read("specs/001-touchmyapi-platform/atlas.html");

    expect(atlas).not.toMatch(/arquivo HTTP ou DNS TXT/i);
    expect(atlas).not.toMatch(/DNS[- ]TXT.*(?:autoriza|verifica)/i);
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
});
