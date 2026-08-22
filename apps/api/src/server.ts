import { app } from "./app";

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`TouchMyAPI API listening on http://localhost:${port}`);
