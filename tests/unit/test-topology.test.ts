import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

it("keeps each Vitest suite directory and the pending e2e gate in place", () => {
  expect(existsSync(resolve(repositoryRoot, "tests/contract"))).toBe(true);
  expect(existsSync(resolve(repositoryRoot, "tests/integration"))).toBe(true);
  expect(existsSync(resolve(repositoryRoot, "tests/isolation"))).toBe(true);
  expect(existsSync(resolve(repositoryRoot, "tests/e2e/pending.test.ts"))).toBe(true);
});
