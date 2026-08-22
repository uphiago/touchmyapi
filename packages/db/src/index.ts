import postgres from "postgres";

export * from "../schema";

export type DbConnection = ReturnType<typeof postgres>;
export type DbTransaction = postgres.TransactionSql;

/**
 * Connection factory for the TouchMyAPI data layer.
 *
 * Receives `DATABASE_URL` explicitly so no connection is ever opened during
 * module import and no credentials are read from ambient state. Throws a clear
 * configuration error when the URL is absent rather than failing lazily.
 *
 */
export function createDbConnection(databaseUrl: string | undefined): DbConnection {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to create a database connection. Set it before calling createDbConnection.",
    );
  }

  return postgres(databaseUrl);
}
