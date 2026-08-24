export {};

const root = process.cwd();
const composeFile = "infra/docker/compose.yml";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi";
const localWebOrigin = "http://127.0.0.1:5173";
const localApiOrigin = "http://127.0.0.1:3000";
const localAdminWebOrigin = "http://127.0.0.1:5174";
const localAdminApiOrigin = "http://127.0.0.1:3001";
const localWorkerOrigin = "http://127.0.0.1:3002";
const connectorEnv = {
  DATABASE_URL: databaseUrl,
  AUTH_DATABASE_URL:
    "postgres://auth_connector:touchmyapi_auth_local_2026@127.0.0.1:5433/touchmyapi",
  API_DATABASE_URL: "postgres://api_connector:touchmyapi_api_local_2026@127.0.0.1:5433/touchmyapi",
  AUDIT_DATABASE_URL:
    "postgres://audit_system_connector:touchmyapi_audit_local_2026@127.0.0.1:5433/touchmyapi",
  QUEUE_DATABASE_URL:
    "postgres://queue_connector:touchmyapi_queue_local_2026@127.0.0.1:5433/touchmyapi",
  WORKER_DATABASE_URL:
    "postgres://worker_connector:touchmyapi_worker_local_2026@127.0.0.1:5433/touchmyapi",
  REPORTING_DATABASE_URL:
    "postgres://reporting_connector:touchmyapi_reporting_local_2026@127.0.0.1:5433/touchmyapi",
};
const webArgs = ["--host", "127.0.0.1", "--strictPort"];
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

async function run(
  command: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<void> {
  const process = Bun.spawn({
    cmd: [command, ...args],
    cwd: root,
    env: { ...baseEnv, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${exitCode}`);
}

if (process.env.TOUCHMYAPI_EXTERNAL_MINIO !== "1") {
  await run("docker", ["compose", "--profile", "local", "-f", composeFile, "up", "-d", "minio"]);
}
await run("docker", [
  "compose",
  "--profile",
  "local",
  "-f",
  composeFile,
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  "120",
  "postgres",
]);
await run("bun", ["run", "db:migrate"], { DATABASE_URL: databaseUrl });
await run("bun", ["packages/db/scripts/configure-connectors.ts"], connectorEnv);
await run("bun", ["packages/db/scripts/seed-local.ts"], { DATABASE_URL: databaseUrl });

const children = [
  Bun.spawn({
    cmd: ["bun", "--cwd", "apps/api", "dev"],
    cwd: root,
    env: {
      ...baseEnv,
      ...connectorEnv,
      CORS_ORIGIN: localWebOrigin,
      LOCAL_MOCKS: "1",
      LOCAL_PERSISTENCE: "postgres",
      PORT: "3000",
    },
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn({
    cmd: ["bun", "--cwd", "apps/api", "dev:admin"],
    cwd: root,
    env: {
      ...baseEnv,
      ADMIN_CORS_ORIGIN: localAdminWebOrigin,
      LOCAL_ADMIN_MOCKS: "1",
      ADMIN_PORT: "3001",
    },
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn({
    cmd: ["bun", "--cwd", "apps/worker-control", "dev"],
    cwd: root,
    env: {
      ...baseEnv,
      ...connectorEnv,
      NODE_ENV: "development",
      RUNNER_MODE: "fixture",
      WORKER_ID: "local-fixture-worker",
      WORKER_PORT: new URL(localWorkerOrigin).port,
    },
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn({
    cmd: ["bun", "--cwd", "apps/admin", "dev", "--", ...webArgs, "--port", "5174"],
    cwd: root,
    env: {
      ...baseEnv,
      VITE_ADMIN_API_BASE_URL: localAdminApiOrigin,
      VITE_LOCAL_ADMIN_MOCKS: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn({
    cmd: ["bun", "--cwd", "apps/web", "dev", "--", ...webArgs],
    cwd: root,
    env: { ...baseEnv, VITE_API_BASE_URL: localApiOrigin, VITE_LOCAL_MOCKS: "1" },
    stdout: "inherit",
    stderr: "inherit",
  }),
];

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[local] received ${signal}; stopping customer, admin, and worker processes`);
  for (const child of children) child.kill("SIGTERM");
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const exitPromises = children.map((child) => child.exited);
const firstExit = await Promise.race(
  exitPromises.map(async (promise, index) => ({ index, code: await promise })),
);
if (!shuttingDown && firstExit.code !== 0) {
  console.error(`[local] child process ${firstExit.index} failed with ${firstExit.code}`);
  shutdown("child failure");
  process.exit(1);
}
await Promise.all(exitPromises);
