import { defineConfig } from "vitest/config";

const testProject = (name: string, include: string[]) => ({
  test: {
    name,
    include,
  },
});

export default defineConfig({
  test: {
    projects: [
      testProject("unit", [
        "tests/unit/**/*.test.ts",
        "apps/**/test/**/*.test.ts",
        "packages/**/test/**/*.test.ts",
      ]),
      testProject("contract", ["tests/contract/**/*.test.ts"]),
      testProject("integration", ["tests/integration/**/*.test.ts"]),
      testProject("isolation", ["tests/isolation/**/*.test.ts"]),
      testProject("e2e", ["tests/e2e/**/*.test.ts"]),
    ],
  },
});
