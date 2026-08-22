import type { DbConnection } from "./index";

/** Runtime roles are deliberately closed to the roles provisioned by migrations. */
export type RuntimeRole = "api_rls" | "worker_rls" | "reporting_rls";

/** The callback receives only the tenant-scoped query surface. */
export type TenantConnection = {
  unsafe<T extends Record<string, unknown>>(query: string, values?: unknown[]): Promise<T[]>;
};

const RUNTIME_ROLE_SQL: Readonly<Record<RuntimeRole, string>> = {
  api_rls: '"api_rls"',
  worker_rls: '"worker_rls"',
  reporting_rls: '"reporting_rls"',
};

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalAccountId(accountId: string): string {
  if (typeof accountId !== "string" || !CANONICAL_UUID.test(accountId)) {
    throw new TypeError("accountId must be a canonical UUID");
  }
  return accountId.toLowerCase();
}

function roleSql(role: RuntimeRole): string {
  if (typeof role !== "string" || !Object.hasOwn(RUNTIME_ROLE_SQL, role)) {
    throw new TypeError("role must be a supported runtime role");
  }
  return RUNTIME_ROLE_SQL[role as RuntimeRole];
}

/**
 * Run a callback in a transaction with an explicit tenant and least-privilege role.
 *
 * Both settings are LOCAL, and the postgres client releases the transaction's
 * borrowed connection only after commit or rollback. The callback cannot retain
 * a usable query surface after the transaction has ended.
 */
export async function withTenant<T>(
  connection: DbConnection,
  accountId: string,
  role: RuntimeRole,
  callback: (db: TenantConnection) => Promise<T>,
): Promise<T> {
  const tenantId = canonicalAccountId(accountId);
  const selectedRole = roleSql(role);
  if (typeof callback !== "function") {
    throw new TypeError("callback must be a function");
  }

  return (await connection.begin(async (transaction) => {
    await transaction.unsafe("select set_config('app.tenant', $1, true)", [tenantId]);
    await transaction.unsafe(`set local role ${selectedRole}`);

    let callbackCompleted = false;
    let active = true;
    try {
      const result = await callback({
        unsafe: async <Row extends Record<string, unknown>>(
          query: string,
          values?: unknown[],
        ): Promise<Row[]> => {
          if (!active) throw new Error("TenantConnection is no longer active");
          return (await transaction.unsafe(query, values as never)) as Row[];
        },
      });
      callbackCompleted = true;
      return result;
    } finally {
      active = false;
      // On callback failure PostgreSQL marks the transaction aborted; rollback
      // at the begin boundary resets LOCAL state. On success reset explicitly
      // before commit as an additional guard against borrowed-connection leaks.
      if (callbackCompleted) {
        await transaction.unsafe("reset role");
        await transaction.unsafe("reset app.tenant");
      }
    }
  })) as T;
}
