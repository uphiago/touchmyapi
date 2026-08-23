import { AsyncLocalStorage } from "node:async_hooks";
import {
  getRawTenantDatabase,
  type RawDbConnection,
  type TenantDatabase,
} from "./connection-internal";
import { activateTenantContext, expireTenantContext } from "./tenant-internal";
import { createTenantAccountCapability, type TenantAccountCapability } from "./tenant-account";

/** Runtime roles are deliberately closed to the roles provisioned by migrations. */
export type RuntimeRole = "api_rls" | "worker_rls" | "reporting_rls";

/** The callback receives only closed, typed tenant capabilities. */
export type TenantContext<R extends RuntimeRole = RuntimeRole> = {
  readonly role: R;
  readonly account: TenantAccountCapability<R>;
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

const API_INSERT_TABLES = [
  "assessment",
  "authorization_attestation",
  "verification",
  "credential",
  "audit_event",
  "agent",
] as const;
const API_SELECT_TABLES = [
  "account",
  "user",
  "assessment",
  "authorization_attestation",
  "verification",
  "playbook",
  "credential",
  "finding",
  "report",
  "credit_entry",
  "entitlement",
  "agent",
  "audit_event",
  "notification",
] as const;
const API_UPDATE_TABLES = [
  "account",
  "assessment",
  "verification",
  "credential",
  "agent",
  "notification",
] as const;
const API_DELETE_TABLES = ["credential", "agent"] as const;
const WORKER_INSERT_TABLES = [
  "job",
  "runner_execution",
  "finding",
  "report",
  "audit_event",
  "notification",
] as const;
const WORKER_SELECT_TABLES = [
  "account",
  "user",
  "assessment",
  "authorization_attestation",
  "verification",
  "playbook",
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
const WORKER_UPDATE_TABLES = [
  "assessment",
  "verification",
  "job",
  "runner_execution",
  "finding",
  "report",
  "agent",
  "notification",
] as const;
const WORKER_DELETE_TABLES = ["job", "runner_execution", "credential"] as const;
const REPORTING_SELECT_TABLES = [
  "account",
  "user",
  "assessment",
  "authorization_attestation",
  "verification",
  "playbook",
  "job",
  "runner_execution",
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
  "lo_export",
  "lo_import",
  "lo_unlink",
  "loread",
  "lowrite",
  "listen",
  "lock",
  "notify",
  "pg_cancel_backend",
  "pg_file_write",
  "pg_log_backend_memory_contexts",
  "pg_ls_dir",
  "pg_notify",
  "pg_read_binary_file",
  "pg_read_file",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_stat_file",
  "pg_temp",
  "pg_terminate_backend",
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
  "temp",
  "temporary",
  "uescape",
  "truncate",
  "unlisten",
  "vacuum",
]);

const ALLOWED_ROOT_TOKENS = new Set(["select", "insert", "update", "delete"]);
const tenantContext = new AsyncLocalStorage<RawDbConnection>();

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

type SqlToken = {
  kind: "word" | "string" | "punctuation";
  value: string;
  quoted?: boolean;
};

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
    if (/^u\s*&\s*["']/i.test(query.slice(index))) {
      rejectTenantQuery("Unicode escape identifiers and strings are not allowed");
    }
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
      tokens.push({ kind: "word", value: value.toLowerCase(), quoted: true });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/.test(query[end] ?? "")) end += 1;
      tokens.push({ kind: "word", value: query.slice(index, end).toLowerCase(), quoted: false });
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

// Retained only for compatibility with migration history; no tenant callback can invoke it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function validateTenantQuery(query: string): void {
  const tokens = tokenizeTenantQuery(query);
  let depth = 0;
  const positionedTokens = tokens.map((token) => {
    if (token.value === ")") {
      depth -= 1;
      if (depth < 0) rejectTenantQuery("unbalanced parentheses");
    }
    const positioned = { ...token, depth };
    if (token.value === "(") depth += 1;
    return positioned;
  });
  if (depth !== 0) rejectTenantQuery("unbalanced parentheses");

  for (const token of positionedTokens) {
    if (
      token.kind === "word" &&
      (FORBIDDEN_TOKENS.has(token.value) ||
        token.value.startsWith("pg_temp_") ||
        token.value.startsWith("lo_") ||
        /^pg_.*advisory.*lock/.test(token.value))
    ) {
      rejectTenantQuery(`forbidden token ${token.value}`);
    }
  }

  const firstWord = positionedTokens.find((token) => token.kind === "word" && !token.quoted)?.value;
  if (!firstWord) rejectTenantQuery("statement has no command");
  const command = firstWord;
  if (command !== "with" && !ALLOWED_ROOT_TOKENS.has(command)) {
    rejectTenantQuery("only SELECT, INSERT, UPDATE, DELETE, or a DML CTE is allowed");
  }
  let rootCommand = command;
  if (command === "with") {
    rootCommand = "";
    for (const token of positionedTokens.slice(1)) {
      if (token.depth === 0 && token.kind === "word" && ALLOWED_ROOT_TOKENS.has(token.value)) {
        rootCommand = token.value;
        break;
      }
    }
    if (!rootCommand) rejectTenantQuery("CTE must terminate in a DML statement");
  }

  const commandAtDepth = new Map<number, string>();
  for (const token of positionedTokens) {
    if (token.kind === "word" && !token.quoted && ALLOWED_ROOT_TOKENS.has(token.value)) {
      commandAtDepth.set(token.depth, token.value);
    }
    if (token.kind === "word" && !token.quoted && token.value === "into") {
      if (commandAtDepth.get(token.depth) !== "insert") {
        rejectTenantQuery("SELECT INTO or nested INTO is not allowed");
      }
    }
  }
}

type PrincipalRow = {
  principal: string;
  session_principal: string;
  backend_pid: number;
  is_superuser: boolean;
  bypasses_rls: boolean;
  inherits_roles: boolean;
  can_create_db: boolean;
  can_create_role: boolean;
  can_replicate: boolean;
  role_member: boolean;
  role_settable: boolean;
  database_owner: boolean;
  table_owner: boolean;
  direct_tenant_access: boolean;
  direct_public_table_access: boolean;
  direct_function_access: boolean;
  unsafe_membership: boolean;
};

type PrincipalIdentity = {
  backendPid: number;
  sessionPrincipal: string;
};

async function assertSafePrincipal(
  connection: RawDbConnection,
  roleName: string,
): Promise<PrincipalIdentity> {
  // Production deploys must provision a dedicated login connector with
  // NOINHERIT/NOSUPERUSER/NOBYPASSRLS and only the runtime memberships it
  // needs. The raw migration owner must never be used by application code.
  const principalRows = await connection`
    with recursive tenant_tables(name) as (
      select unnest(${TENANT_TABLES}::text[])
    ), reachable_roles(oid, set_allowed) as (
      select m.roleid, m.set_option
      from pg_auth_members m
      join pg_roles member_role on member_role.oid = m.member
      where member_role.rolname = current_user
      union
      select m.roleid, rr.set_allowed and m.set_option
      from pg_auth_members m
      join reachable_roles rr on rr.oid = m.member
    )
    select
      current_user::text as principal,
      session_user::text as session_principal,
      pg_backend_pid() as backend_pid,
      r.rolsuper as is_superuser,
      r.rolbypassrls as bypasses_rls,
      r.rolinherit as inherits_roles,
      r.rolcreatedb as can_create_db,
      r.rolcreaterole as can_create_role,
      r.rolreplication as can_replicate,
      pg_has_role(current_user, ${roleName}, 'member') as role_member,
      exists (
        select 1
        from reachable_roles rr
        join pg_roles reachable on reachable.oid = rr.oid
        where reachable.rolname = ${roleName} and rr.set_allowed
      ) as role_settable,
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
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        where n.nspname not in ('pg_catalog', 'information_schema')
          and acl.grantee = r.oid
          and acl.privilege_type = 'EXECUTE'
      ) as direct_function_access
      , exists (
        select 1
        from reachable_roles rr
        join pg_roles reachable on reachable.oid = rr.oid
        where not rr.set_allowed
           or reachable.rolname <> all(${Object.values(RUNTIME_ROLE_NAMES)}::text[])
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
           or exists (
             select 1
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname not in ('pg_catalog', 'information_schema') and p.proowner = reachable.oid
           )
           or exists (
             select 1
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
             where n.nspname not in ('pg_catalog', 'information_schema')
               and acl.grantee = reachable.oid
               and acl.privilege_type = 'EXECUTE'
               and p.prosecdef
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
  if (principal.direct_function_access) unsafeReasons.push("direct application function EXECUTE");
  if (principal.unsafe_membership) unsafeReasons.push("unsafe reachable role membership");
  if (!principal.role_member) unsafeReasons.push(`not a member of ${roleName}`);
  if (!principal.role_settable) unsafeReasons.push(`membership for ${roleName} has SET FALSE`);
  if (unsafeReasons.length > 0) {
    throw new Error(`tenant connection principal rejected: ${unsafeReasons.join(", ")}`);
  }
  return {
    backendPid: Number(principal.backend_pid),
    sessionPrincipal: principal.session_principal,
  };
}

type SwitchedPrincipalRow = {
  principal: string;
  session_principal: string;
  backend_pid: number;
  is_superuser: boolean;
  bypasses_rls: boolean;
  inherits_roles: boolean;
  can_create_db: boolean;
  can_create_role: boolean;
  can_replicate: boolean;
  database_owner: boolean;
  table_owner: boolean;
  unsafe_membership: boolean;
  unexpected_table_access: boolean;
  unexpected_function_access: boolean;
};

async function assertSwitchedPrincipal(
  connection: RawDbConnection,
  roleName: RuntimeRole,
  expectedSessionPrincipal: string,
  expectedBackendPid: number,
): Promise<void> {
  const rows = await connection`
    with recursive reachable_roles(oid, set_allowed) as (
      select m.roleid, m.set_option
      from pg_auth_members m
      join pg_roles member_role on member_role.oid = m.member
      where member_role.rolname = current_user
      union
      select m.roleid, rr.set_allowed and m.set_option
      from pg_auth_members m
      join reachable_roles rr on rr.oid = m.member
    )
    select
      current_user::text as principal,
      session_user::text as session_principal,
      pg_backend_pid() as backend_pid,
      r.rolsuper as is_superuser,
      r.rolbypassrls as bypasses_rls,
      r.rolinherit as inherits_roles,
      r.rolcreatedb as can_create_db,
      r.rolcreaterole as can_create_role,
      r.rolreplication as can_replicate,
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
        from reachable_roles rr
        join pg_roles reachable on reachable.oid = rr.oid
        where not rr.set_allowed
           or reachable.rolname <> all(${Object.values(RUNTIME_ROLE_NAMES)}::text[])
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
             select 1 from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public'
               and c.relkind in ('r', 'p', 'v', 'm')
               and c.relowner = reachable.oid
           )
           or exists (
             select 1 from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname not in ('pg_catalog', 'information_schema') and p.proowner = reachable.oid
           )
           or exists (
             select 1
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
             where n.nspname not in ('pg_catalog', 'information_schema')
               and acl.grantee = reachable.oid
               and acl.privilege_type = 'EXECUTE'
               and p.prosecdef
           )
      ) as unsafe_membership,
      exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
        where n.nspname = 'public'
          and acl.grantee = r.oid
          and (
            (r.rolname = 'api_rls' and (
              (acl.privilege_type = 'SELECT' and c.relname <> all(${API_SELECT_TABLES}::text[]))
              or (acl.privilege_type = 'INSERT' and c.relname <> all(${API_INSERT_TABLES}::text[]))
              or (acl.privilege_type = 'UPDATE' and c.relname <> all(${API_UPDATE_TABLES}::text[]))
              or (acl.privilege_type = 'DELETE' and c.relname <> all(${API_DELETE_TABLES}::text[]))
              or acl.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
            ))
            or (r.rolname = 'worker_rls' and (
              (acl.privilege_type = 'SELECT' and c.relname <> all(${WORKER_SELECT_TABLES}::text[]))
              or (acl.privilege_type = 'INSERT' and c.relname <> all(${WORKER_INSERT_TABLES}::text[]))
              or (acl.privilege_type = 'UPDATE' and c.relname <> all(${WORKER_UPDATE_TABLES}::text[]))
              or (acl.privilege_type = 'DELETE' and c.relname <> all(${WORKER_DELETE_TABLES}::text[]))
              or acl.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
            ))
            or (r.rolname = 'reporting_rls' and (
              acl.privilege_type <> 'SELECT'
              or c.relname <> all(${REPORTING_SELECT_TABLES}::text[])
            ))
          )
      ) as unexpected_table_access,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        where n.nspname not in ('pg_catalog', 'information_schema')
          and acl.grantee = r.oid
          and acl.privilege_type = 'EXECUTE'
          and not (
            n.nspname = 'public'
            and (
              (
                p.proname = 'rls_tenant_matches'
                and oidvectortypes(p.proargtypes) = 'uuid'
                and not p.prosecdef
              )
              or (
                p.proname = 'rls_bootstrap_context'
                and oidvectortypes(p.proargtypes) = ''
                and not p.prosecdef
              )
            )
          )
      ) as unexpected_function_access
    from pg_roles r
    where r.rolname = current_user
  `;
  const principal = rows[0] as SwitchedPrincipalRow | undefined;
  if (!principal) throw new Error("tenant switched principal could not be inspected");
  const unsafeReasons: string[] = [];
  if (principal.principal !== roleName) unsafeReasons.push(`current role is not ${roleName}`);
  if (principal.session_principal !== expectedSessionPrincipal) {
    unsafeReasons.push("session principal changed");
  }
  if (Number(principal.backend_pid) !== expectedBackendPid) {
    unsafeReasons.push("tenant transaction backend changed");
  }
  if (principal.is_superuser) unsafeReasons.push("switched role is superuser");
  if (principal.bypasses_rls) unsafeReasons.push("switched role has BYPASSRLS");
  if (principal.inherits_roles) unsafeReasons.push("switched role inherits memberships");
  if (principal.can_create_db || principal.can_create_role || principal.can_replicate) {
    unsafeReasons.push("switched role has elevated capabilities");
  }
  if (principal.database_owner) unsafeReasons.push("switched role owns database");
  if (principal.table_owner) unsafeReasons.push("switched role owns public table");
  if (principal.unsafe_membership) unsafeReasons.push("switched role has unsafe memberships");
  if (principal.unexpected_table_access)
    unsafeReasons.push("switched role has unexpected table privileges");
  if (principal.unexpected_function_access) {
    unsafeReasons.push("switched role has unexpected function EXECUTE");
  }
  if (unsafeReasons.length > 0) {
    throw new Error(`tenant switched principal rejected: ${unsafeReasons.join(", ")}`);
  }
}

/**
 * Run a callback in a transaction with an explicit tenant and least-privilege role.
 *
 * Both settings are LOCAL, and the postgres client releases the transaction's
 * borrowed connection only after commit or rollback. The callback cannot retain
 * a usable query surface after the transaction has ended.
 */
export async function withTenant<T, R extends RuntimeRole = RuntimeRole>(
  connection: TenantDatabase,
  accountId: string,
  role: R,
  callback: (context: TenantContext<R>) => Promise<T>,
): Promise<T> {
  const tenantId = canonicalAccountId(accountId);
  const rawConnection = getRawTenantDatabase(connection);
  const selectedRole = roleSql(role);
  const selectedRoleName = RUNTIME_ROLE_NAMES[role];
  if (typeof callback !== "function") {
    throw new TypeError("callback must be a function");
  }
  if (tenantContext.getStore() === rawConnection) {
    throw new Error("nested withTenant on the same DbConnection is not allowed");
  }
  const reserved = await rawConnection.reserve();
  try {
    const result = await tenantContext.run(rawConnection, async () => {
      let transactionStarted = false;
      try {
        // BEGIN must precede connector inspection: both preflight and SET ROLE
        // revalidation then share one reserved backend and one atomic boundary.
        await reserved.unsafe("begin");
        transactionStarted = true;
        await reserved.unsafe("set local statement_timeout = '5s'");
        await reserved.unsafe("set local lock_timeout = '1s'");
        await reserved.unsafe("set local idle_in_transaction_session_timeout = '30s'");
        await reserved.unsafe("set local search_path = pg_catalog, public, pg_temp");
        const connectorIdentity = await assertSafePrincipal(reserved, selectedRoleName);
        await reserved.unsafe("select set_config('app.tenant', $1, true)", [tenantId]);
        await reserved.unsafe(`set local role ${selectedRole}`);
        await assertSwitchedPrincipal(
          reserved,
          role,
          connectorIdentity.sessionPrincipal,
          connectorIdentity.backendPid,
        );

        const context = {
          role,
          account: undefined as unknown as TenantAccountCapability<R>,
        } as TenantContext<R>;
        const account = createTenantAccountCapability(context);
        Object.defineProperty(context, "account", {
          value: account,
          enumerable: true,
          writable: false,
          configurable: false,
        });
        Object.freeze(context);
        activateTenantContext(context, reserved, tenantId, role);
        let callbackCompleted = false;
        let result!: T;
        try {
          result = await callback(context);
          callbackCompleted = true;
        } finally {
          expireTenantContext(context);
        }
        // On callback failure PostgreSQL marks the transaction aborted; rollback
        // below resets LOCAL state. On success reset explicitly before commit as
        // an additional guard against borrowed-connection leaks.
        if (callbackCompleted) {
          await reserved.unsafe("reset role");
          await reserved.unsafe("reset app.tenant");
        }
        await reserved.unsafe("commit");
        return result as T;
      } catch (error) {
        if (transactionStarted) {
          try {
            await reserved.unsafe("rollback");
          } catch {
            // Preserve the original setup/callback/commit error.
          }
        }
        throw error;
      }
    });
    return result;
  } finally {
    try {
      await reserved.unsafe("discard temp");
      await reserved.unsafe("select 1 as tenant_connection_cleanup");
    } finally {
      reserved.release();
    }
  }
}
