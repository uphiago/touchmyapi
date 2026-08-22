import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("policy workspace contract", () => {
  it("declares the policy package dependencies used by the frozen workspace lock", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, "packages/policy/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const lockfile = readFileSync(resolve(repositoryRoot, "bun.lock"), "utf8");

    expect(manifest.dependencies?.["@touchmyapi/contracts"]).toBe("workspace:*");
    expect(manifest.dependencies?.zod).toBe("^3.24.1");
    expect(lockfile).toContain('"packages/policy"');
    expect(lockfile).toContain('"@touchmyapi/contracts"');
  });

  it("resolves the policy package through the workspace export", async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, "packages/policy/package.json"), "utf8"),
    ) as { exports: { ".": string } };
    const entrypoint = resolve(repositoryRoot, "packages/policy", manifest.exports["."]);
    const policy = await import(pathToFileURL(entrypoint).href);
    expect(typeof policy.matchesScope).toBe("function");
    expect(typeof policy.compileScope).toBe("function");
  });
});
