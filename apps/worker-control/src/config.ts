export type WorkerEnvironment = "development" | "test" | "production";
export type RunnerMode = "fixture" | "isolated";

export type WorkerConfig = Readonly<{
  environment: WorkerEnvironment;
  runnerMode: RunnerMode;
  queueDatabaseUrl: string;
  workerDatabaseUrl: string;
  workerId: string;
  pollIntervalMs: number;
  leaseSeconds: number;
  port: number;
  storage: Readonly<{
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    createBucket: boolean;
  }>;
}>;

const WORKER_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function connectorUrl(value: string, name: string, role: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    decodeURIComponent(parsed.username) !== role ||
    !parsed.password ||
    !parsed.hostname ||
    !parsed.pathname.slice(1)
  ) {
    throw new Error(`${name} must use ${role}`);
  }
  return parsed.toString();
}

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}

export function loadWorkerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerConfig {
  const environment: WorkerEnvironment =
    env.NODE_ENV === "production" || env.NODE_ENV === "test" ? env.NODE_ENV : "development";
  const runnerMode = (env.RUNNER_MODE ??
    (environment === "production" ? "isolated" : "fixture")) as RunnerMode;
  if (runnerMode !== "fixture" && runnerMode !== "isolated") {
    throw new Error("RUNNER_MODE is invalid");
  }
  if (environment === "production" && runnerMode === "fixture") {
    throw new Error("fixture runner is forbidden in production");
  }
  const workerId = env.WORKER_ID?.trim() || `worker-${crypto.randomUUID()}`;
  if (!WORKER_ID.test(workerId)) throw new Error("WORKER_ID is invalid");
  return Object.freeze({
    environment,
    runnerMode,
    queueDatabaseUrl: connectorUrl(
      required(env, "QUEUE_DATABASE_URL"),
      "QUEUE_DATABASE_URL",
      "queue_connector",
    ),
    workerDatabaseUrl: connectorUrl(
      required(env, "WORKER_DATABASE_URL"),
      "WORKER_DATABASE_URL",
      "worker_connector",
    ),
    workerId,
    pollIntervalMs: integer(
      env.WORKER_POLL_INTERVAL_MS,
      500,
      "WORKER_POLL_INTERVAL_MS",
      100,
      60_000,
    ),
    leaseSeconds: integer(env.WORKER_LEASE_SECONDS, 120, "WORKER_LEASE_SECONDS", 10, 900),
    port: integer(env.WORKER_PORT, 3002, "WORKER_PORT", 1, 65_535),
    storage: Object.freeze({
      endpoint:
        env.OBJECT_STORAGE_ENDPOINT?.trim() ||
        (environment === "development" || environment === "test"
          ? "http://127.0.0.1:9000"
          : required(env, "OBJECT_STORAGE_ENDPOINT")),
      bucket:
        env.OBJECT_STORAGE_BUCKET?.trim() ||
        (environment === "development" || environment === "test"
          ? "touchmyapi-reports"
          : required(env, "OBJECT_STORAGE_BUCKET")),
      region: env.OBJECT_STORAGE_REGION?.trim() || "auto",
      accessKeyId:
        env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() ||
        (environment === "development" || environment === "test"
          ? "touchmyapi_dev"
          : required(env, "OBJECT_STORAGE_ACCESS_KEY_ID")),
      secretAccessKey:
        env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() ||
        (environment === "development" || environment === "test"
          ? "touchmyapi_dev_change_me"
          : required(env, "OBJECT_STORAGE_SECRET_ACCESS_KEY")),
      createBucket: environment !== "production",
    }),
  });
}
