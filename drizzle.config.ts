import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for migrations");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/schema/*.ts",
  out: "./packages/db/migrations",
  dbCredentials: {
    url: databaseUrl,
  },
});
