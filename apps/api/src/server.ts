import { app } from "./app";
import { loadConfig } from "./config";
import { createLocalDevelopmentApp } from "./local-development";

const config = loadConfig();
const runtimeApp =
  config.environment === "development" && process.env.LOCAL_MOCKS === "1"
    ? createLocalDevelopmentApp(config)
    : app;

Bun.serve({
  port: config.port,
  fetch: runtimeApp.fetch,
});
