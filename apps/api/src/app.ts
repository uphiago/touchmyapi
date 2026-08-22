import { Hono } from "hono";
import { errorResponseSchema, healthResponseSchema } from "@touchmyapi/contracts";

export const app = new Hono();

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
