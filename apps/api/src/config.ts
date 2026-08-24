export type ApiEnvironment = "development" | "test" | "production";

export type ApiConfig = Readonly<{
  corsOrigin: string;
  environment: ApiEnvironment;
  port: number;
}>;

type ConfigInput = Readonly<{
  corsOrigin: string;
  environment?: ApiEnvironment;
  port?: number;
}>;

function validateOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("invalid API CORS origin");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) {
    throw new Error("invalid API CORS origin");
  }
  return parsed.origin;
}

export function createConfig(input: ConfigInput): ApiConfig {
  if (!input || typeof input !== "object") throw new Error("invalid API configuration");
  const corsOrigin = validateOrigin(input.corsOrigin);
  const environment = input.environment ?? "development";
  if (!["development", "test", "production"].includes(environment)) {
    throw new Error("invalid API environment");
  }
  const port = input.port ?? 3000;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid API port");
  }
  return Object.freeze({ corsOrigin, environment, port });
}

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApiConfig {
  return createConfig({
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:5173",
    environment:
      env.NODE_ENV === "production" || env.NODE_ENV === "test" ? env.NODE_ENV : "development",
    port: env.PORT === undefined ? 3000 : Number(env.PORT),
  });
}
