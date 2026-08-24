import { createRawDbConnection, type RawDbConnection } from "./connection-internal";

export type AuthDatabase = {
  readonly __authDatabaseBrand: unique symbol;
};

const authConnections = new WeakMap<object, RawDbConnection>();

export function createAuthDatabase(databaseUrl: string | undefined): AuthDatabase {
  const raw = createRawDbConnection(databaseUrl);
  const handle = Object.freeze({}) as AuthDatabase;
  authConnections.set(handle, raw);
  return handle;
}

export function getRawAuthDatabase(database: AuthDatabase): RawDbConnection {
  const raw = authConnections.get(database);
  if (!raw) throw new TypeError("invalid auth database handle");
  return raw;
}

export async function closeAuthDatabase(database: AuthDatabase): Promise<void> {
  const raw = getRawAuthDatabase(database);
  authConnections.delete(database);
  await raw.end();
}
