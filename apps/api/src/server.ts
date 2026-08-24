import { loadConfig } from "./config";
import { createLocalDevelopmentApp } from "./local-development";
import { createApiRuntime } from "./runtime";

const config = loadConfig();
const local = config.environment === "development" && process.env.LOCAL_MOCKS === "1";
const runtime = local ? undefined : await createApiRuntime();
const runtimeApp = local ? createLocalDevelopmentApp(config) : runtime!.app;

const shutdown = async () => {
  await runtime?.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

Bun.serve({
  port: config.port,
  fetch: runtimeApp.fetch,
});
