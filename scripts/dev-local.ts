export {};

const root = process.cwd();
const composeFile = "infra/docker/compose.yml";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi";
const apiUrl = process.env.VITE_API_BASE_URL ?? "http://localhost:3000";
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
    env: { ...baseEnv, CORS_ORIGIN: "http://localhost:5173", PORT: "3000" },
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn({
    cmd: ["bun", "--cwd", "apps/web", "dev", "--", "--host", "127.0.0.1"],
    cwd: root,
    env: { ...baseEnv, VITE_API_BASE_URL: apiUrl },
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

const exitCodes = await Promise.all(children.map((child) => child.exited));
if (!shuttingDown && exitCodes.some((code) => code !== 0)) {
  throw new Error(`[local] child process failed: ${exitCodes.join(", ")}`);
}
