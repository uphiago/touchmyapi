import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/schema/*.ts",
  out: "./packages/db/migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://touchmyapi_dev:touchmyapi_dev@localhost:5433/touchmyapi",
  },
});
