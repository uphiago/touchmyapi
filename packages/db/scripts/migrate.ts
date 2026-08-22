const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required for migrations");
  process.exit(1);
}

const migration = Bun.spawn({
  cmd: ["bunx", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
  cwd: new URL("../../../", import.meta.url).pathname,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await migration.exited);
