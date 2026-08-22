import { Hono } from "hono";
import { cors } from "hono/cors";
import { errorResponseSchema, healthResponseSchema } from "@touchmyapi/contracts";

export const app = new Hono();

app.use(
  "/health",
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  }),
);

app.get("/health", (c) => {
  return c.json(healthResponseSchema.parse({ status: "ok" }));
});

app.notFound((c) => {
  return c.json(
    errorResponseSchema.parse({
      error: { code: "not_found", message: "Not Found" },
    }),
    404,
  );
});
