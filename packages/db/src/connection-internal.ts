import postgres from "postgres";

/** Opaque handle accepted by withTenant; its backend is private to this module. */
export type TenantDatabase = {
  readonly __tenantDatabaseBrand: unique symbol;
};

/** Opaque handle accepted only by withSystemAudit. */
export type SystemAuditDatabase = {
  readonly __systemAuditDatabaseBrand: unique symbol;
};

export type RawDbConnection = ReturnType<typeof postgres>;
export type RawDbTransaction = postgres.TransactionSql;

const rawConnections = new WeakMap<object, RawDbConnection>();
const systemAuditConnections = new WeakMap<object, RawDbConnection>();

export function createTenantDatabase(databaseUrl: string | undefined): TenantDatabase {
  const raw = createRawDbConnection(databaseUrl);
  const handle = Object.freeze({}) as TenantDatabase;
  rawConnections.set(handle, raw);
  return handle;
}

export function getRawTenantDatabase(database: TenantDatabase): RawDbConnection {
  const raw = rawConnections.get(database);
  if (!raw) throw new TypeError("invalid tenant database handle");
  return raw;
}

export function createSystemAuditDatabase(databaseUrl: string | undefined): SystemAuditDatabase {
  const raw = createRawDbConnection(databaseUrl);
  const handle = Object.freeze({}) as SystemAuditDatabase;
  systemAuditConnections.set(handle, raw);
  return handle;
}

export function getRawSystemAuditDatabase(database: SystemAuditDatabase): RawDbConnection {
  const raw = systemAuditConnections.get(database);
  if (!raw) throw new TypeError("invalid system audit database handle");
  return raw;
}

/** Internal-only factory for migrations and admin test fixtures. */
export function createRawDbConnection(databaseUrl: string | undefined): RawDbConnection {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to create a database connection. Set it before calling createRawDbConnection.",
    );
  }
  return postgres(databaseUrl);
}
