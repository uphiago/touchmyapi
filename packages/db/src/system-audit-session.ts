import { AsyncLocalStorage } from "node:async_hooks";
import {
  getRawSystemAuditDatabase,
  type RawDbConnection,
  type SystemAuditDatabase,
} from "./connection-internal";
import {
  activateSystemAuditContext,
  expireSystemAuditContext,
  type SystemAuditBackend,
} from "./system-audit-internal";

export type SystemAuditContext = Readonly<Record<never, never>>;

const systemAuditContext = new AsyncLocalStorage<RawDbConnection>();
const BUSINESS_TABLES = [
  "account",
  "user",
  "session",
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
  "notification",
] as const;

type PrincipalIdentity = { backendPid: number; sessionPrincipal: string };

function stableReject(message: string): never {
  throw new Error(`system audit connection rejected: ${message}`);
}

async function assertConnectorSafe(connection: RawDbConnection): Promise<PrincipalIdentity> {
  const rows = await connection.unsafe(
    `with recursive reachable_roles(oid, set_allowed) as (
       select m.roleid, m.set_option
       from pg_auth_members m
       join pg_roles member_role on member_role.oid = m.member
       where member_role.rolname = current_user
       union
       select m.roleid, rr.set_allowed and m.set_option
       from pg_auth_members m
       join reachable_roles rr on rr.oid = m.member
     )
     select current_user::text as principal, session_user::text as session_principal,
       pg_backend_pid() as backend_pid, r.rolsuper as is_superuser,
       r.rolbypassrls as bypasses_rls, r.rolinherit as inherits_roles,
       r.rolcreatedb as can_create_db, r.rolcreaterole as can_create_role,
       r.rolreplication as can_replicate,
       pg_has_role(current_user, 'audit_system', 'member') as role_member,
       exists (select 1 from reachable_roles rr join pg_roles x on x.oid = rr.oid
               where x.rolname = 'audit_system' and rr.set_allowed) as role_settable,
       exists (select 1 from pg_database d where d.datname = current_database() and d.datdba = r.oid) as database_owner,
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind in ('r','p','v','m') and c.relowner = r.oid) as table_owner,
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
               where n.nspname = 'public' and acl.grantee = r.oid
                 and acl.privilege_type in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')) as direct_table_access,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
               where n.nspname not in ('pg_catalog','information_schema') and acl.grantee = r.oid
                 and acl.privilege_type = 'EXECUTE') as direct_function_access,
       exists (select 1 from reachable_roles rr join pg_roles x on x.oid = rr.oid
               where not rr.set_allowed or x.rolname <> 'audit_system' or x.rolsuper
                 or x.rolbypassrls or x.rolinherit or x.rolcreatedb or x.rolcreaterole
                 or x.rolreplication
                 or exists (select 1 from pg_database d where d.datname = current_database() and d.datdba = x.oid)
                 or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind in ('r','p','v','m') and c.relowner = x.oid)
                 or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname not in ('pg_catalog','information_schema') and p.proowner = x.oid)) as unsafe_membership
     from pg_roles r where r.rolname = current_user`,
  );
  const principal = rows[0] as Record<string, unknown> | undefined;
  if (!principal) stableReject("connector principal could not be inspected");
  const reasons: string[] = [];
  if (principal.principal !== principal.session_principal)
    reasons.push("role was already switched");
  if (principal.is_superuser) reasons.push("superuser");
  if (principal.bypasses_rls) reasons.push("BYPASSRLS");
  if (principal.inherits_roles) reasons.push("INHERIT connector");
  if (principal.can_create_db || principal.can_create_role || principal.can_replicate)
    reasons.push("elevated role capability");
  if (principal.database_owner) reasons.push("database owner");
  if (principal.table_owner) reasons.push("public table owner");
  if (principal.direct_table_access) reasons.push("direct public table access");
  if (principal.direct_function_access) reasons.push("direct public function access");
  if (principal.unsafe_membership) reasons.push("unsafe reachable role membership");
  if (!principal.role_member) reasons.push("not a member of audit_system");
  if (!principal.role_settable) reasons.push("audit_system membership cannot be set");
  if (reasons.length) stableReject(reasons.join(", "));
  return {
    backendPid: Number(principal.backend_pid),
    sessionPrincipal: String(principal.session_principal),
  };
}

async function assertSystemRole(
  connection: RawDbConnection,
  identity: PrincipalIdentity,
): Promise<void> {
  const rows = await connection.unsafe(
    `with recursive reachable_roles(oid, set_allowed) as (
       select m.roleid, m.set_option from pg_auth_members m
       join pg_roles member_role on member_role.oid = m.member
       where member_role.rolname = current_user
       union select m.roleid, rr.set_allowed and m.set_option
       from pg_auth_members m join reachable_roles rr on rr.oid = m.member
     )
     select current_user::text as principal, session_user::text as session_principal,
       pg_backend_pid() as backend_pid, r.rolsuper as is_superuser,
       r.rolbypassrls as bypasses_rls, r.rolinherit as inherits_roles,
       r.rolcreatedb as can_create_db, r.rolcreaterole as can_create_role,
       r.rolreplication as can_replicate,
       exists (select 1 from pg_database d where d.datname = current_database() and d.datdba = r.oid) as database_owner,
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind in ('r','p','v','m') and c.relowner = r.oid) as table_owner,
       exists (select 1 from reachable_roles rr join pg_roles x on x.oid = rr.oid
               where not rr.set_allowed or x.rolname <> 'audit_system' or x.rolsuper
                 or x.rolbypassrls or x.rolinherit or x.rolcreatedb or x.rolcreaterole or x.rolreplication
                 or exists (select 1 from pg_database d where d.datname = current_database() and d.datdba = x.oid)
                 or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind in ('r','p','v','m') and c.relowner = x.oid)) as unsafe_membership,
       has_table_privilege(current_user, 'public.audit_event', 'select') as audit_select,
       has_table_privilege(current_user, 'public.audit_event', 'insert') as audit_insert,
       has_table_privilege(current_user, 'public.audit_event', 'update') as audit_update,
       has_table_privilege(current_user, 'public.audit_event', 'delete') as audit_delete,
       has_table_privilege(current_user, 'public.audit_system_state', 'select') as state_select,
       has_table_privilege(current_user, 'public.audit_system_state', 'insert') as state_insert,
       has_table_privilege(current_user, 'public.audit_system_state', 'update') as state_update,
       has_table_privilege(current_user, 'public.audit_system_state', 'delete') as state_delete,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
               where n.nspname not in ('pg_catalog','information_schema') and acl.grantee = r.oid
                 and acl.privilege_type = 'EXECUTE') as function_access
     from pg_roles r where r.rolname = current_user`,
  );
  const rowsTables = await connection.unsafe(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name = any($1::text[])
       and (has_table_privilege(current_user, format('public.%I', table_name), 'select')
         or has_table_privilege(current_user, format('public.%I', table_name), 'insert')
         or has_table_privilege(current_user, format('public.%I', table_name), 'update')
         or has_table_privilege(current_user, format('public.%I', table_name), 'delete'))`,
    [BUSINESS_TABLES],
  );
  const principal = rows[0] as Record<string, unknown> | undefined;
  const businessAccess = rowsTables.length > 0;
  if (!principal) stableReject("switched principal could not be inspected");
  const reasons: string[] = [];
  if (principal.principal !== "audit_system") reasons.push("current role is not audit_system");
  if (principal.session_principal !== identity.sessionPrincipal)
    reasons.push("session principal changed");
  if (Number(principal.backend_pid) !== identity.backendPid)
    reasons.push("transaction backend changed");
  if (principal.is_superuser) reasons.push("switched role is superuser");
  if (principal.bypasses_rls) reasons.push("switched role has BYPASSRLS");
  if (principal.inherits_roles) reasons.push("switched role inherits memberships");
  if (principal.can_create_db || principal.can_create_role || principal.can_replicate)
    reasons.push("switched role has elevated capabilities");
  if (principal.database_owner) reasons.push("switched role owns database");
  if (principal.table_owner) reasons.push("switched role owns public table");
  if (principal.unsafe_membership) reasons.push("switched role has unsafe memberships");
  if (
    !principal.audit_select ||
    !principal.audit_insert ||
    principal.audit_update ||
    principal.audit_delete
  )
    reasons.push("unexpected audit privileges");
  if (
    !principal.state_select ||
    !principal.state_update ||
    principal.state_insert ||
    principal.state_delete
  )
    reasons.push("unexpected singleton privileges");
  if (principal.function_access || businessAccess) reasons.push("unexpected project access");
  if (reasons.length) stableReject(reasons.join(", "));
}

export async function withSystemAudit<T>(
  database: SystemAuditDatabase,
  callback: (context: SystemAuditContext) => Promise<T>,
): Promise<T> {
  const rawConnection = getRawSystemAuditDatabase(database);
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  if (systemAuditContext.getStore() === rawConnection) {
    throw new Error("nested withSystemAudit on the same DbConnection is not allowed");
  }
  const reserved = await rawConnection.reserve();
  try {
    return await systemAuditContext.run(rawConnection, async () => {
      let transactionStarted = false;
      try {
        await reserved.unsafe("begin");
        transactionStarted = true;
        await reserved.unsafe("set local statement_timeout = '5s'");
        await reserved.unsafe("set local lock_timeout = '1s'");
        await reserved.unsafe("set local idle_in_transaction_session_timeout = '30s'");
        await reserved.unsafe("set local search_path = pg_catalog, public, pg_temp");
        const identity = await assertConnectorSafe(reserved);
        await reserved.unsafe('set local role "audit_system"');
        await assertSystemRole(reserved, identity);
        const context = Object.freeze({}) as SystemAuditContext;
        activateSystemAuditContext(context, reserved as unknown as SystemAuditBackend);
        let callbackComplete = false;
        let result!: T;
        try {
          result = await callback(context);
          callbackComplete = true;
        } finally {
          expireSystemAuditContext(context);
        }
        if (callbackComplete) await reserved.unsafe("reset role");
        await reserved.unsafe("commit");
        return result;
      } catch (error) {
        if (transactionStarted) {
          try {
            await reserved.unsafe("rollback");
          } catch {
            // Preserve the original setup or callback failure.
          }
        }
        throw error;
      }
    });
  } finally {
    try {
      await reserved.unsafe("discard temp");
      await reserved.unsafe("select 1 as system_audit_connection_cleanup");
    } finally {
      reserved.release();
    }
  }
}
