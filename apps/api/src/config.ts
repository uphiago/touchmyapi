export type ApiEnvironment = "development" | "test" | "production";

export type ApiConfig = Readonly<{
  corsOrigin: string;
  environment: ApiEnvironment;
  port: number;
}>;

export type AuthProviderMode = "github" | "mock" | "disabled";

export type ApiRuntimeConfig = ApiConfig &
  Readonly<{
    authProvider: AuthProviderMode;
    webAppOrigin: string;
    authTransientKey: Uint8Array;
    sessionMaxAgeSeconds: number;
    transientMaxAgeSeconds: number;
    authDatabaseUrl: string;
    apiDatabaseUrl: string;
    auditDatabaseUrl: string;
    github?: Readonly<{
      clientId: string;
      clientSecret: string;
      callbackUrl: string;
    }>;
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

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateAbsoluteUrl(value: string, name: string, httpsOnly: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (
    (httpsOnly && parsed.protocol !== "https:") ||
    (!httpsOnly && !["http:", "https:"].includes(parsed.protocol))
  ) {
    throw new Error(`${name} is invalid`);
  }
  return parsed.toString();
}

function decodeTransientKey(value: string): Uint8Array {
  try {
    const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (decoded.byteLength !== 32) throw new Error("invalid key length");
    return decoded;
  } catch {
    throw new Error("AUTH_TRANSIENT_KEY must encode exactly 32 bytes");
  }
}

function boundedSeconds(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 60 || parsed > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
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

export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApiRuntimeConfig {
  const base = loadConfig(env);
  const authProvider = (env.AUTH_PROVIDER ??
    (base.environment === "development" ? "mock" : "github")) as AuthProviderMode;
  if (authProvider !== "github" && authProvider !== "mock" && authProvider !== "disabled") {
    throw new Error("unsupported authentication provider");
  }
  if (authProvider === "mock" && base.environment !== "development") {
    throw new Error("mock authentication is development-only");
  }

  const production = base.environment === "production";
  let github: ApiRuntimeConfig["github"];
  if (authProvider === "github") {
    try {
      github = Object.freeze({
        clientId: required(env, "GITHUB_OAUTH_CLIENT_ID"),
        clientSecret: required(env, "GITHUB_OAUTH_CLIENT_SECRET"),
        callbackUrl: validateAbsoluteUrl(
          required(env, "GITHUB_OAUTH_CALLBACK_URL"),
          "GITHUB_OAUTH_CALLBACK_URL",
          production,
        ),
      });
    } catch {
      throw new Error("GitHub OAuth configuration unavailable");
    }
  }

  const fallbackDatabaseUrl = env.DATABASE_URL?.trim() || undefined;
  const databaseUrl = (name: string): string => {
    const value =
      env[name]?.trim() || (base.environment === "development" ? fallbackDatabaseUrl : undefined);
    if (!value) throw new Error(`${name} is required`);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${name} is invalid`);
    }
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
      !parsed.hostname ||
      !parsed.pathname.slice(1)
    ) {
      throw new Error(`${name} is invalid`);
    }
    return parsed.toString();
  };

  const keyValue = env.AUTH_TRANSIENT_KEY?.trim();
  const authTransientKey = keyValue
    ? decodeTransientKey(keyValue)
    : authProvider === "mock" && base.environment === "development"
      ? new Uint8Array(32).fill(7)
      : (() => {
          throw new Error("AUTH_TRANSIENT_KEY is required");
        })();

  return Object.freeze({
    ...base,
    authProvider,
    webAppOrigin: validateOrigin(env.WEB_APP_ORIGIN ?? base.corsOrigin),
    authTransientKey,
    sessionMaxAgeSeconds: boundedSeconds(
      env.AUTH_SESSION_MAX_AGE_SECONDS,
      86_400,
      "AUTH_SESSION_MAX_AGE_SECONDS",
      31 * 86_400,
    ),
    transientMaxAgeSeconds: boundedSeconds(
      env.AUTH_TRANSIENT_MAX_AGE_SECONDS,
      600,
      "AUTH_TRANSIENT_MAX_AGE_SECONDS",
      900,
    ),
    authDatabaseUrl: databaseUrl("AUTH_DATABASE_URL"),
    apiDatabaseUrl: databaseUrl("API_DATABASE_URL"),
    auditDatabaseUrl: databaseUrl("AUDIT_DATABASE_URL"),
    ...(github ? { github } : {}),
  });
}
