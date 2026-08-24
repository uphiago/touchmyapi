import { defineConfig } from "vitest/config";

type TestProjectOptions = {
  exclude?: string[];
  fileParallelism?: boolean;
  maxWorkers?: number;
  passWithNoTests?: boolean;
};

const testProject = (name: string, include: string[], options: TestProjectOptions = {}) => ({
  test: {
    name,
    include,
    passWithNoTests: options.passWithNoTests ?? false,
    ...(options.fileParallelism === undefined ? {} : { fileParallelism: options.fileParallelism }),
    ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }),
    ...(options.exclude ? { exclude: options.exclude } : {}),
  },
});

export default defineConfig({
  test: {
    // Database projects share cluster-global roles and the queue singleton.
    // A single worker keeps privilege mutation and singleton assertions deterministic.
    fileParallelism: false,
    maxWorkers: 1,
    projects: [
      testProject(
        "unit",
        [
          "tests/unit/**/*.test.ts",
          "apps/**/test/**/*.test.ts",
          "apps/*/src/**/*.test.tsx",
          "packages/policy/test/**/*.test.ts",
          "packages/secrets/test/**/*.test.ts",
          "packages/db/test/configure-connectors.test.ts",
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
      testProject(
        "integration",
        [
          "tests/integration/**/*.test.ts",
          "packages/db/test/**/*.integration.test.ts",
          "apps/**/test/**/*.integration.test.ts",
        ],
        { fileParallelism: false, maxWorkers: 1 },
      ),
      testProject(
        "isolation",
        ["tests/isolation/**/*.test.ts", "packages/db/test/**/*.isolation.test.ts"],
        { fileParallelism: false, maxWorkers: 1 },
      ),
      testProject("e2e", ["tests/e2e/**/*.test.ts"], { passWithNoTests: true }),
    ],
  },
});
