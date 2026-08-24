import postgres from "postgres";

type ConnectorRole = "auth_connector" | "api_connector" | "audit_system_connector";

export type ConnectorCredential = Readonly<{
  role: ConnectorRole;
  password: string;
  url: string;
}>;

const CONNECTORS = [
  ["AUTH_DATABASE_URL", "auth_connector"],
  ["API_DATABASE_URL", "api_connector"],
  ["AUDIT_DATABASE_URL", "audit_system_connector"],
] as const;

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePostgresUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.pathname.slice(1) ||
    parsed.hash
  ) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}

function decoded(value: string, name: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
}

function databaseBoundary(url: URL): string {
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${url.pathname.slice(1)}`;
}

export function connectorCredentialPlan(
  env: Readonly<Record<string, string | undefined>>,
): readonly ConnectorCredential[] {
  const migration = parsePostgresUrl(required(env, "DATABASE_URL"), "DATABASE_URL");
  const boundary = databaseBoundary(migration);
  return Object.freeze(
    CONNECTORS.map(([name, role]) => {
      const url = required(env, name);
      const parsed = parsePostgresUrl(url, name);
      const username = decoded(parsed.username, name);
      const password = decoded(parsed.password, name);
      if (
        username !== role ||
        password.length < 16 ||
        password.length > 1024 ||
        password.includes("\0")
      ) {
        throw new Error(`${name} connector credentials are invalid`);
      }
      if (databaseBoundary(parsed) !== boundary) {
        throw new Error(`${name} must use the migrated database boundary`);
      }
      return Object.freeze({ role, password, url });
    }),
  );
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function configureConnectorCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const migrationUrl = required(env, "DATABASE_URL");
  const plan = connectorCredentialPlan(env);
  const migration = postgres(migrationUrl, { max: 1 });
  try {
    for (const connector of plan) {
      await migration.unsafe(
        `ALTER ROLE ${connector.role} PASSWORD ${quoteLiteral(connector.password)}`,
      );
    }
  } finally {
    await migration.end();
  }

  for (const connector of plan) {
    const connection = postgres(connector.url, { max: 1 });
    try {
      const rows = await connection.unsafe("select current_user as role");
      if (rows[0]?.role !== connector.role) throw new Error("connector verification failed");
    } finally {
      await connection.end();
    }
  }
}

if (import.meta.main) {
  try {
    await configureConnectorCredentials();
    process.stdout.write("[connectors] least-privilege logins configured\n");
  } catch {
    process.stderr.write("[connectors] configuration failed\n");
    process.exit(1);
  }
}
