export {};

const root = process.cwd();
const env = {
  ...process.env,
  TOUCHMYAPI_IMAGE_TAG: "0".repeat(40),
  POSTGRES_DB: "touchmyapi",
  POSTGRES_USER: "touchmyapi",
  POSTGRES_PASSWORD: "validation-only-not-a-production-secret",
  DATABASE_URL: "postgres://touchmyapi:validation@postgres:5432/touchmyapi",
  CUSTOMER_WEB_ORIGIN: "https://app.example.invalid",
  ADMIN_WEB_ORIGIN: "https://admin.example.invalid",
};
const processResult = Bun.spawn({
  cmd: ["docker", "compose", "-f", "infra/docker/compose.production.yml", "config", "--quiet"],
  cwd: root,
  env,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await processResult.exited);
