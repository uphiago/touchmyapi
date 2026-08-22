import { defineConfig } from "vitest/config";

type TestProjectOptions = {
  exclude?: string[];
  passWithNoTests?: boolean;
};

const testProject = (name: string, include: string[], options: TestProjectOptions = {}) => ({
  test: {
    name,
    include,
    passWithNoTests: options.passWithNoTests ?? false,
    ...(options.exclude ? { exclude: options.exclude } : {}),
  },
});

export default defineConfig({
  test: {
    projects: [
      testProject(
        "unit",
        [
          "tests/unit/**/*.test.ts",
          "apps/**/test/**/*.test.ts",
          "packages/policy/test/**/*.test.ts",
          "packages/secrets/test/**/*.test.ts",
          "packages/**/test/**/*.unit.test.ts",
        ],
        {
          exclude: ["**/node_modules/**", "apps/**/test/**/*.integration.test.ts"],
        },
      ),
      testProject("contract", [
        "tests/contract/**/*.test.ts",
        "packages/contracts/test/**/*.test.ts",
        "packages/playbooks/test/**/*.test.ts",
      ]),
      testProject("integration", [
        "tests/integration/**/*.test.ts",
        "packages/db/test/**/*.integration.test.ts",
        "apps/**/test/**/*.integration.test.ts",
      ]),
      testProject("isolation", [
        "tests/isolation/**/*.test.ts",
        "packages/db/test/**/*.isolation.test.ts",
      ]),
      testProject("e2e", ["tests/e2e/**/*.test.ts"], { passWithNoTests: true }),
    ],
  },
});
