import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import vitestConfig from "../../vitest.config";

const repositoryRoot = resolve(import.meta.dirname, "../..");

it("keeps each Vitest suite directory and the pending e2e gate in place", () => {
  expect(existsSync(resolve(repositoryRoot, "tests/contract"))).toBe(true);
  expect(existsSync(resolve(repositoryRoot, "tests/integration"))).toBe(true);
  expect(existsSync(resolve(repositoryRoot, "tests/isolation"))).toBe(true);
  expect(existsSync(resolve(repositoryRoot, "tests/e2e/pending.test.ts"))).toBe(true);
});

it("keeps integration app tests out of the unit project", () => {
  type Project = { test?: { exclude?: string[]; name?: string } };
  const projects = (vitestConfig.test?.projects ?? []) as unknown as Project[];
  const unitProject = projects.find((project) => project.test?.name === "unit");

  expect(unitProject?.test?.exclude).toContain("apps/**/test/**/*.integration.test.ts");
});
