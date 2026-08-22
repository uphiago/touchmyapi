const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.log("Skipping database migrations: DATABASE_URL is not set.");
  process.exit(0);
}

const migration = Bun.spawn({
  cmd: ["bunx", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
  cwd: new URL("../../../", import.meta.url).pathname,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await migration.exited);
