import { createWorkerRuntime, runWorkerLoop } from "./runtime";

const runtime = await createWorkerRuntime();
const controller = new AbortController();
let ready = true;

const server = Bun.serve({
  port: runtime.config.port,
  hostname: "0.0.0.0",
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({ status: "ok", service: "worker-control" });
    }
    if (path === "/ready") {
      return Response.json(
        { status: ready ? "ready" : "stopping", runner: runtime.config.runnerMode },
        { status: ready ? 200 : 503 },
      );
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  },
});

const loop = runWorkerLoop(runtime, controller.signal);

async function shutdown(): Promise<void> {
  if (!ready) return;
  ready = false;
  controller.abort();
  server.stop(false);
  await loop;
  await runtime.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
