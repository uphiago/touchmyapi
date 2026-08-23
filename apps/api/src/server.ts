import { app } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();

Bun.serve({
  port: config.port,
  fetch: app.fetch,
});
