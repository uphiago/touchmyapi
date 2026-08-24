import { loadConfig } from "./config";
import { createLocalDevelopmentApp } from "./local-development";
import { createPersistentLocalDevelopmentApp } from "./local-persistent";
import { createApiRuntime } from "./runtime";

const config = loadConfig();
const local = config.environment === "development" && process.env.LOCAL_MOCKS === "1";
const persistentLocal = local && process.env.LOCAL_PERSISTENCE === "postgres";
const localRuntime = persistentLocal
  ? await createPersistentLocalDevelopmentApp(
      config,
      process.env.API_DATABASE_URL ??
        (() => {
          throw new Error("API_DATABASE_URL is required");
        })(),
    )
  : undefined;
const runtime = local ? undefined : await createApiRuntime();
const runtimeApp = localRuntime?.app ?? (local ? createLocalDevelopmentApp(config) : runtime!.app);

const shutdown = async () => {
  await runtime?.close();
  await localRuntime?.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

Bun.serve({
  port: config.port,
  fetch: runtimeApp.fetch,
});
