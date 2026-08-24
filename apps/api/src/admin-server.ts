import { Hono } from "hono";
import { createLocalAdminApp } from "./admin-local";

const port = Number(process.env.ADMIN_PORT ?? 3001);
const localEnabled = process.env.NODE_ENV !== "production" && process.env.LOCAL_ADMIN_MOCKS === "1";

const unavailable = new Hono();
unavailable.get("/health", (context) =>
  context.json({ status: "ok", boundary: "admin", capabilities: "unavailable" }),
);
unavailable.all("/api/v1/admin/*", (context) =>
  context.json({ error: { code: "admin_unavailable", message: "Admin backend unavailable" } }, 503),
);

const app = localEnabled
  ? createLocalAdminApp({ corsOrigin: process.env.ADMIN_CORS_ORIGIN ?? "http://127.0.0.1:5174" })
  : unavailable;

Bun.serve({ port, fetch: app.fetch });
