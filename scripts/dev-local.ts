export {};

const root = process.cwd();
const composeFile = "infra/docker/compose.yml";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi";
const localWebOrigin = "http://127.0.0.1:5173";
const localApiOrigin = "http://127.0.0.1:3000";
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

await run("docker", ["compose", "--profile", "local", "-f", composeFile, "up", "-d", "postgres"]);
await run("bun", ["run", "db:migrate"], { DATABASE_URL: databaseUrl });

const children = [
  Bun.spawn({
    cmd: ["bun", "--cwd", "apps/api", "dev"],
    cwd: root,
    env: { ...baseEnv, CORS_ORIGIN: localWebOrigin, LOCAL_MOCKS: "1", PORT: "3000" },
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
  console.log(`[local] received ${signal}; stopping API and web processes`);
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
