import { AsyncLocalStorage } from "node:async_hooks";
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

const RUNTIME_ROLE_NAMES: Readonly<Record<RuntimeRole, string>> = {
  api_rls: "api_rls",
  worker_rls: "worker_rls",
  reporting_rls: "reporting_rls",
};

const TENANT_TABLES = [
  "account",
  "user",
  "session",
  "assessment",
  "authorization_attestation",
  "verification",
  "job",
  "runner_execution",
  "credential",
  "finding",
  "report",
  "credit_entry",
  "billing_event",
  "entitlement",
  "agent",
  "audit_event",
  "notification",
] as const;

const FORBIDDEN_TOKENS = new Set([
  "alter",
  "analyze",
  "begin",
  "call",
  "cluster",
  "close",
  "commit",
  "copy",
  "create",
  "current_setting",
  "current_user",
  "deallocate",
  "declare",
  "discard",
  "drop",
  "execute",
  "grant",
  "listen",
  "lock",
  "notify",
  "prepare",
  "reindex",
  "release",
  "reset",
  "revoke",
  "rollback",
  "savepoint",
  "session_user",
  "set_config",
  "start",
  "truncate",
  "unlisten",
  "vacuum",
]);

const ALLOWED_ROOT_TOKENS = new Set(["select", "insert", "update", "delete"]);
const tenantContext = new AsyncLocalStorage<DbConnection>();

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

type SqlToken = { kind: "word" | "string" | "punctuation"; value: string };

function rejectTenantQuery(reason: string): never {
  throw new TypeError(`tenant query blocked by SQL firewall: ${reason}`);
}

function tokenizeTenantQuery(query: string): SqlToken[] {
  if (typeof query !== "string" || query.trim() === "") {
    rejectTenantQuery("query must be a non-empty string");
  }

  const tokens: SqlToken[] = [];
  for (let index = 0; index < query.length;) {
    const character = query[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === ";") rejectTenantQuery("multiple statements are not allowed");
    if (
      (character === "-" && query[index + 1] === "-") ||
      (character === "/" && query[index + 1] === "*")
    ) {
      rejectTenantQuery("comments are not allowed");
    }
    if (character === "$") {
      if (/\d/.test(query[index + 1] ?? "")) {
        let end = index + 2;
        while (/\d/.test(query[end] ?? "")) end += 1;
        tokens.push({ kind: "punctuation", value: query.slice(index, end) });
        index = end;
        continue;
      }
      rejectTenantQuery("dollar-quoted strings are not allowed");
    }
    if (character === "'") {
      let end = index + 1;
      while (end < query.length) {
        if (query[end] === "'") {
          if (query[end + 1] === "'") {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      if (query[end - 1] !== "'") rejectTenantQuery("unterminated string literal");
      tokens.push({ kind: "string", value: query.slice(index, end) });
      index = end;
      continue;
    }
    if (character === '"') {
      let end = index + 1;
      let value = "";
      while (end < query.length) {
        if (query[end] === '"') {
          if (query[end + 1] === '"') {
            value += '"';
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        value += query[end];
        end += 1;
      }
      if (query[end - 1] !== '"') rejectTenantQuery("unterminated quoted identifier");
      tokens.push({ kind: "word", value: value.toLowerCase() });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/.test(query[end] ?? "")) end += 1;
      tokens.push({ kind: "word", value: query.slice(index, end).toLowerCase() });
      index = end;
      continue;
    }
    if (/[0-9]/.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9_.]/.test(query[end] ?? "")) end += 1;
      tokens.push({ kind: "punctuation", value: query.slice(index, end) });
      index = end;
      continue;
    }
    if ("(),.*:+-/%=<>!|&[]?#@~^".includes(character)) {
      tokens.push({ kind: "punctuation", value: character });
      index += 1;
      continue;
    }
    rejectTenantQuery(`unsupported SQL character ${JSON.stringify(character)}`);
  }
  return tokens;
}

function validateTenantQuery(query: string): void {
  const tokens = tokenizeTenantQuery(query);
  for (const token of tokens) {
    if (token.kind === "word" && FORBIDDEN_TOKENS.has(token.value)) {
      rejectTenantQuery(`forbidden token ${token.value}`);
    }
  }

  const firstWord = tokens.find((token) => token.kind === "word")?.value;
  if (!firstWord) rejectTenantQuery("statement has no command");
  const command = firstWord;
  if (command !== "with" && !ALLOWED_ROOT_TOKENS.has(command)) {
    rejectTenantQuery("only SELECT, INSERT, UPDATE, DELETE, or a DML CTE is allowed");
  }
  if (command === "select") {
    let depth = 0;
    for (const token of tokens.slice(1)) {
      if (token.value === "(") {
        depth += 1;
        continue;
      }
      if (token.value === ")") {
        depth -= 1;
        continue;
      }
      if (depth === 0 && token.kind === "word" && token.value === "into") {
        rejectTenantQuery("SELECT INTO is not allowed");
      }
    }
  }
  if (command === "with") {
    let depth = 0;
    let rootCommand: string | undefined;
    for (const token of tokens.slice(1)) {
      if (token.value === "(") {
        depth += 1;
        continue;
      }
      if (token.value === ")") {
        depth -= 1;
        continue;
      }
      if (depth === 0 && token.kind === "word" && ALLOWED_ROOT_TOKENS.has(token.value)) {
        rootCommand = token.value;
        break;
      }
    }
    if (!rootCommand) rejectTenantQuery("CTE must terminate in a DML statement");
  }
}

type PrincipalRow = {
  principal: string;
  session_principal: string;
  is_superuser: boolean;
  bypasses_rls: boolean;
  inherits_roles: boolean;
  can_create_db: boolean;
  can_create_role: boolean;
  can_replicate: boolean;
  role_member: boolean;
  database_owner: boolean;
  table_owner: boolean;
  direct_tenant_access: boolean;
  direct_public_table_access: boolean;
  unsafe_membership: boolean;
};

async function assertSafePrincipal(connection: DbConnection, roleName: string): Promise<void> {
  // Production deploys must provision a dedicated login connector with
  // NOINHERIT/NOSUPERUSER/NOBYPASSRLS and only the runtime memberships it
  // needs. The raw migration owner must never be used by application code.
  const principalRows = await connection`
    with recursive tenant_tables(name) as (
      select unnest(${TENANT_TABLES}::text[])
    ), reachable_roles(oid) as (
      select m.roleid
      from pg_auth_members m
      join pg_roles member_role on member_role.oid = m.member
      where member_role.rolname = current_user
      union
      select m.roleid
      from pg_auth_members m
      join reachable_roles rr on rr.oid = m.member
    )
    select
      current_user::text as principal,
      session_user::text as session_principal,
      r.rolsuper as is_superuser,
      r.rolbypassrls as bypasses_rls,
      r.rolinherit as inherits_roles,
      r.rolcreatedb as can_create_db,
      r.rolcreaterole as can_create_role,
      r.rolreplication as can_replicate,
      pg_has_role(current_user, ${roleName}, 'member') as role_member,
      exists (
        select 1 from pg_database d
        where d.datname = current_database() and d.datdba = r.oid
      ) as database_owner,
      exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and c.relowner = r.oid
      ) as table_owner,
      exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join tenant_tables t on t.name = c.relname
        cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
        where n.nspname = 'public'
          and acl.grantee = r.oid
          and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
      ) as direct_tenant_access
      , exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
        where n.nspname = 'public'
          and c.relkind in ('r', 'p', 'v', 'm')
          and acl.grantee = r.oid
          and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
      ) as direct_public_table_access
      , exists (
        select 1
        from reachable_roles rr
        join pg_roles reachable on reachable.oid = rr.oid
        where reachable.rolname <> all(${Object.values(RUNTIME_ROLE_NAMES)}::text[])
           or reachable.rolsuper
           or reachable.rolbypassrls
           or reachable.rolcreatedb
           or reachable.rolcreaterole
           or reachable.rolreplication
           or exists (
             select 1 from pg_database d
             where d.datname = current_database() and d.datdba = reachable.oid
           )
           or exists (
             select 1
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public'
               and c.relkind in ('r', 'p', 'v', 'm')
               and c.relowner = reachable.oid
           )
      ) as unsafe_membership
    from pg_roles r
    where r.rolname = current_user
  `;
  const principal = principalRows[0] as PrincipalRow | undefined;
  if (!principal) throw new Error("tenant connection principal could not be inspected");
  const unsafeReasons: string[] = [];
  if (principal.principal !== principal.session_principal)
    unsafeReasons.push("role was already switched");
  if (principal.is_superuser) unsafeReasons.push("superuser");
  if (principal.bypasses_rls) unsafeReasons.push("BYPASSRLS");
  if (principal.inherits_roles) unsafeReasons.push("INHERIT connector");
  if (principal.can_create_db || principal.can_create_role || principal.can_replicate) {
    unsafeReasons.push("elevated role capability");
  }
  if (principal.database_owner) unsafeReasons.push("database owner");
  if (principal.table_owner) unsafeReasons.push("public table owner");
  if (principal.direct_tenant_access) unsafeReasons.push("direct tenant table access");
  if (principal.direct_public_table_access) unsafeReasons.push("direct public table access");
  if (principal.unsafe_membership) unsafeReasons.push("unsafe reachable role membership");
  if (!principal.role_member) unsafeReasons.push(`not a member of ${roleName}`);
  if (unsafeReasons.length > 0) {
    throw new Error(`tenant connection principal rejected: ${unsafeReasons.join(", ")}`);
  }
}

async function abortTransaction(transaction: { unsafe: DbConnection["unsafe"] }): Promise<never> {
  try {
    await transaction.unsafe("select 1 / 0");
  } catch {
    // The deliberate error marks the postgres.js transaction scope aborted.
  }
  throw new TypeError("tenant query blocked by SQL firewall");
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
  const selectedRoleName = RUNTIME_ROLE_NAMES[role as RuntimeRole];
  if (typeof callback !== "function") {
    throw new TypeError("callback must be a function");
  }
  if (tenantContext.getStore() === connection) {
    throw new Error("nested withTenant on the same DbConnection is not allowed");
  }
  await assertSafePrincipal(connection, selectedRoleName);

  return tenantContext.run(
    connection,
    async () =>
      (await connection.begin(async (transaction) => {
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
              try {
                validateTenantQuery(query);
              } catch {
                return abortTransaction(transaction);
              }
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
      })) as T,
  );
}
