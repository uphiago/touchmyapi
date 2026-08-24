export {};

const root = process.cwd();
const env = {
  ...process.env,
  TOUCHMYAPI_IMAGE_TAG: "0".repeat(40),
  POSTGRES_DB: "touchmyapi",
  POSTGRES_USER: "touchmyapi",
  POSTGRES_PASSWORD: "validation-only-not-a-production-secret",
  DATABASE_URL: "postgres://touchmyapi:validation@postgres:5432/touchmyapi",
  AUTH_DATABASE_URL: "postgres://auth_connector:validation-auth-password@postgres:5432/touchmyapi",
  API_DATABASE_URL: "postgres://api_connector:validation-api-password@postgres:5432/touchmyapi",
  AUDIT_DATABASE_URL:
    "postgres://audit_system_connector:validation-audit-password@postgres:5432/touchmyapi",
  AUTH_PROVIDER: "disabled",
  AUTH_TRANSIENT_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
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
