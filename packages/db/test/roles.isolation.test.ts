import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const describeDb = RUN_DB_TESTS ? describe : describe.skip;
const TENANT_TABLES = [
  "account",
  "user",
  "assessment",
  "authorization_attestation",
  "verification",
  "session",
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
const MEMBERSHIP_TABLES = ["account_invitation", "account_membership"] as const;
const QUEUE_TABLES = ["outbox_event", "queue_global_state", "queue_tenant_state"] as const;
const AUDIT_STATE_TABLE = "audit_account_state" as const;
const AUTH_FUNCTIONS = [
  [
    "auth_complete_provider_login",
    "identity_provider,text,citext,text,timestamp with time zone,inet,text",
  ],
  ["auth_complete_google_login", "text,citext,text,timestamp with time zone,inet,text"],
  ["auth_session_snapshot", "text"],
  ["auth_resolve_session", "text"],
  ["auth_rotate_session", "text,text,timestamp with time zone"],
  ["auth_revoke_session", "text"],
  ["auth_list_accounts", "text"],
  ["auth_switch_account", "text,uuid,text,timestamp with time zone"],
  ["auth_create_invitation", "text,uuid,citext,membership_role,text,timestamp with time zone"],
  [
    "auth_create_invitation_snapshot",
    "text,uuid,citext,membership_role,text,timestamp with time zone",
  ],
  ["auth_list_memberships", "text,uuid"],
  ["auth_accept_invitation", "text,text,text,timestamp with time zone"],
  ["auth_update_membership", "text,uuid,uuid,membership_role,membership_status"],
  ["auth_update_membership_secure", "text,uuid,uuid,membership_role,membership_status"],
] as const;
const RUNTIME_ROLES = ["api_rls", "worker_rls", "reporting_rls"] as const;
const PRIVILEGES = ["select", "insert", "update", "delete"] as const;
const EXPECTED_TABLE_PRIVILEGES = {
  api_rls: {
    select: [
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
      AUDIT_STATE_TABLE,
      "notification",
      "account_membership",
    ],
    insert: ["assessment", "authorization_attestation", "verification", "credential", "agent"],
    update: [
      "account",
      "assessment",
      "verification",
      "credential",
      "agent",
      "notification",
      AUDIT_STATE_TABLE,
    ],
    delete: ["credential", "agent"],
  },
  worker_rls: {
    select: [
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
      AUDIT_STATE_TABLE,
      "notification",
    ],
    insert: ["job", "runner_execution", "finding", "report", "notification"],
    update: [
      "assessment",
      "verification",
      "job",
      "runner_execution",
      "finding",
      "report",
      "agent",
      "notification",
      AUDIT_STATE_TABLE,
    ],
    delete: ["job", "runner_execution", "credential"],
  },
  reporting_rls: {
    select: [
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
    ],
    insert: [],
    update: [],
    delete: [],
  },
} as const;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizePolicyExpression = (value: unknown) =>
  (value == null ? "" : String(value))
    .replaceAll("public.", "")
    .replaceAll("::text", "")
    .replaceAll("::uuid", "")
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("(NULLIF", "NULLIF")
    .replaceAll(" IS NOT NULL)", " IS NOT NULL")
    .replace(/^\((.*)\)$/, "$1");

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for PostgreSQL isolation tests");
  const database = new URL(value).pathname.slice(1);
  if (!database.endsWith("_test")) throw new Error(`Refusing non-test database: ${database}`);
  return value;
}

describeDb("PostgreSQL least-privilege roles", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForTest());
  });
  afterAll(async () => db?.end());

  it("creates non-login, non-owner, non-inheriting, non-bypass runtime roles", async () => {
    const rows = await db`
      select rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin,
             rolcreatedb, rolcreaterole, rolreplication
      from pg_roles
      where rolname in ('api_rls', 'worker_rls', 'reporting_rls', 'auth_bootstrap')
      order by rolname
    `;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.rolsuper).toBe(false);
      expect(row.rolbypassrls).toBe(false);
      expect(row.rolinherit).toBe(false);
      expect(row.rolcanlogin).toBe(false);
      expect(row.rolcreatedb).toBe(false);
      expect(row.rolcreaterole).toBe(false);
      expect(row.rolreplication).toBe(false);
    }

    const owners = await db`
      select distinct r.rolname
      from pg_roles r
      join pg_class c on c.relowner = r.oid
      where c.relnamespace = 'public'::regnamespace
        and r.rolname in ('api_rls', 'worker_rls', 'reporting_rls', 'auth_bootstrap')
    `;
    expect(owners).toEqual([]);

    const memberships = await db`
      with recursive runtime_memberships(member, roleid) as (
        select m.member, m.roleid
        from pg_auth_members m
        join pg_roles member_role on member_role.oid = m.member
        where member_role.rolname in ('api_rls', 'worker_rls', 'reporting_rls', 'auth_bootstrap')
        union all
        select m.member, m.roleid
        from pg_auth_members m
        join runtime_memberships rm on rm.roleid = m.member
      )
      select member, roleid from runtime_memberships
    `;
    expect(memberships).toEqual([]);
  });

  it("keeps the auth connector login-only with one settable bootstrap membership", async () => {
    const [role] = await db`
      select rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin,
             rolcreatedb, rolcreaterole, rolreplication
      from pg_roles where rolname = 'auth_connector'
    `;
    expect(role).toEqual({
      rolname: "auth_connector",
      rolsuper: false,
      rolbypassrls: false,
      rolinherit: false,
      rolcanlogin: true,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    });
    const memberships = await db`
      select parent.rolname as parent_name
      from pg_auth_members membership
      join pg_roles parent on parent.oid = membership.roleid
      join pg_roles member on member.oid = membership.member
      where member.rolname = 'auth_connector'
      order by parent.rolname
    `;
    expect(memberships).toEqual([{ parent_name: "auth_bootstrap" }]);
    const directPrivileges = await db`
      select
        exists (select 1 from information_schema.table_privileges
                where grantee = 'auth_connector' and table_schema = 'public') as table_access,
        exists (select 1 from pg_proc function
                cross join lateral aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
                where function.pronamespace = 'public'::regnamespace
                  and acl.grantee = 'auth_connector'::regrole
                  and acl.privilege_type = 'EXECUTE') as function_access
    `;
    expect(directPrivileges).toEqual([{ table_access: false, function_access: false }]);
  });

  it("keeps the API connector login-only with one settable tenant membership", async () => {
    const [role] = await db`
      select rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin,
             rolcreatedb, rolcreaterole, rolreplication
      from pg_roles where rolname = 'api_connector'
    `;
    expect(role).toEqual({
      rolname: "api_connector",
      rolsuper: false,
      rolbypassrls: false,
      rolinherit: false,
      rolcanlogin: true,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    });
    const memberships = await db`
      select parent.rolname as parent_name
      from pg_auth_members membership
      join pg_roles parent on parent.oid = membership.roleid
      join pg_roles member on member.oid = membership.member
      where member.rolname = 'api_connector'
    `;
    expect(memberships).toEqual([{ parent_name: "api_rls" }]);
    const [privileges] = await db`
      select
        exists (select 1 from information_schema.table_privileges
                where grantee = 'api_connector' and table_schema = 'public') as table_access,
        exists (select 1 from pg_proc function
                cross join lateral aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
                where function.pronamespace = 'public'::regnamespace
                  and acl.grantee = 'api_connector'::regrole
                  and acl.privilege_type = 'EXECUTE') as function_access
    `;
    expect(privileges).toEqual({ table_access: false, function_access: false });
  });

  it("owns every project table and helper only under the migration owner", async () => {
    const tables = await db`
      select c.relname, r.rolname as owner
      from pg_class c
      join pg_roles r on r.oid = c.relowner
      where c.relnamespace = 'public'::regnamespace
        and c.relkind in ('r', 'p')
      order by c.relname
    `;
    expect(tables.map((row) => row.relname)).toEqual(
      [
        ...TENANT_TABLES,
        ...MEMBERSHIP_TABLES,
        ...QUEUE_TABLES,
        "playbook",
        "audit_system_state",
        AUDIT_STATE_TABLE,
      ].sort(),
    );
    expect(new Set(tables.map((row) => row.owner))).toEqual(new Set([String(tables[0]?.owner)]));
    const functions = await db`
      select p.proname, pg_get_function_identity_arguments(p.oid) as args, r.rolname as owner
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.oid = p.proowner
      where n.nspname = 'public'
        and p.proname in ('rls_tenant_matches', 'rls_bootstrap_context',
                          'auth_complete_provider_login', 'auth_complete_google_login',
                          'auth_session_snapshot', 'auth_resolve_session',
                          'auth_rotate_session', 'auth_revoke_session')
      order by p.proname, args
    `;
    expect(functions).toHaveLength(8);
    expect(new Set(functions.map((row) => row.owner))).toEqual(new Set([String(tables[0]?.owner)]));
  });

  it("has exact table privileges and no PUBLIC object access", async () => {
    for (const role of RUNTIME_ROLES) {
      for (const table of [...TENANT_TABLES, ...MEMBERSHIP_TABLES, "playbook", AUDIT_STATE_TABLE]) {
        for (const privilege of PRIVILEGES) {
          const [row] = await db`
            select has_table_privilege(${role}, ${`public.${table}`}, ${privilege}) as allowed
          `;
          expect(row?.allowed, `${role}/${table}/${privilege}`).toBe(
            (EXPECTED_TABLE_PRIVILEGES[role][privilege] as readonly string[]).includes(table),
          );
        }
      }
    }
    for (const table of [...TENANT_TABLES, ...MEMBERSHIP_TABLES, "playbook", AUDIT_STATE_TABLE]) {
      for (const privilege of PRIVILEGES) {
        const [row] = await db`
          select has_table_privilege('public', ${`public.${table}`}, ${privilege}) as allowed
        `;
        expect(row?.allowed, `PUBLIC/${table}/${privilege}`).toBe(false);
      }
    }
    const [invitationAccountColumn] = await db`
      select has_column_privilege('api_rls', 'public.account_invitation', 'account_id', 'select') as allowed
    `;
    const [invitationTokenColumn] = await db`
      select has_column_privilege('api_rls', 'public.account_invitation', 'token_hash', 'select') as allowed
    `;
    expect(invitationAccountColumn?.allowed).toBe(true);
    expect(invitationTokenColumn?.allowed).toBe(false);
    const [schema] = await db`
      select has_schema_privilege('public', 'public', 'create') as allowed
    `;
    expect(schema?.allowed).toBe(false);

    for (const role of ["audit_system", "audit_system_connector"] as const) {
      for (const table of [...TENANT_TABLES, "playbook", "audit_system_state", AUDIT_STATE_TABLE]) {
        for (const privilege of PRIVILEGES) {
          const [row] = await db`
            select has_table_privilege(${role}, ${`public.${table}`}, ${privilege}) as allowed
          `;
          expect(row?.allowed, `${role}/${table}/${privilege}`).toBe(
            role === "audit_system" && table === "audit_event" && privilege === "select"
              ? true
              : role === "audit_system" &&
                  table === "audit_system_state" &&
                  ["select", "update"].includes(privilege)
                ? true
                : false,
          );
        }
      }
    }
  });

  it("isolates the system audit role to accountless audit rows and the singleton", async () => {
    const roles = await db`
      select rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin,
             rolcreatedb, rolcreaterole, rolreplication
      from pg_roles
      where rolname in ('audit_system', 'audit_system_connector')
      order by rolname
    `;
    expect(roles).toEqual([
      {
        rolname: "audit_system",
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcanlogin: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
      },
      {
        rolname: "audit_system_connector",
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcanlogin: true,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
      },
    ]);
    const [membership] = await db`
      select pg_has_role('audit_system_connector', 'audit_system', 'member') as member
    `;
    expect(membership?.member).toBe(true);
    const policies = await db`
      select c.relname, p.polname, p.polcmd, pg_get_expr(p.polqual, p.polrelid) as using_expr,
             pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      where c.relname in ('audit_event', 'audit_system_state')
        and 'audit_system' = any (array(select r.rolname from pg_roles r where r.oid = any(p.polroles)))
      order by c.relname, p.polname
    `;
    expect(policies.map((row) => row.polname)).toEqual([
      "audit_event_audit_system_insert",
      "audit_event_audit_system_select",
      "audit_system_state_audit_system_lock",
      "audit_system_state_audit_system_select",
    ]);
    expect(policies.map((row) => normalizePolicyExpression(row.using_expr))).toEqual([
      "",
      "account_id IS NULL",
      "id = 'system'",
      "id = 'system'",
    ]);
    expect(policies.map((row) => normalizePolicyExpression(row.check_expr))).toEqual([
      "account_id IS NULL",
      "",
      "id = 'system'",
      "",
    ]);
  });

  it("keeps auth bootstrap without direct table DML and grants explicit runtime access", async () => {
    for (const table of [...TENANT_TABLES, AUDIT_STATE_TABLE]) {
      const privileges = await db`
        select
          has_table_privilege('auth_bootstrap', ${table}, 'select') as select,
          has_table_privilege('auth_bootstrap', ${table}, 'insert') as insert,
          has_table_privilege('auth_bootstrap', ${table}, 'update') as update,
          has_table_privilege('auth_bootstrap', ${table}, 'delete') as delete
      `;
      expect(privileges[0]).toEqual({ select: false, insert: false, update: false, delete: false });
    }

    const auditApi = await db`
      select has_table_privilege('api_rls', 'public.audit_event', 'select') as select,
             has_table_privilege('api_rls', 'public.audit_event', 'insert') as insert,
             has_table_privilege('api_rls', 'public.audit_event', 'update') as update,
             has_table_privilege('api_rls', 'public.audit_event', 'delete') as delete
    `;
    expect(auditApi[0]).toEqual({ select: true, insert: false, update: false, delete: false });

    for (const role of ["api_rls", "worker_rls"] as const) {
      const statePrivileges = await db`
        select has_table_privilege(${role}, 'public.audit_account_state', 'select') as select,
               has_table_privilege(${role}, 'public.audit_account_state', 'insert') as insert,
               has_table_privilege(${role}, 'public.audit_account_state', 'update') as update,
               has_table_privilege(${role}, 'public.audit_account_state', 'delete') as delete
      `;
      expect(statePrivileges[0]).toEqual({
        select: true,
        insert: false,
        update: true,
        delete: false,
      });
    }
    const reportingState = await db`
      select has_table_privilege('reporting_rls', 'public.audit_account_state', 'select') as select,
             has_table_privilege('reporting_rls', 'public.audit_account_state', 'insert') as insert,
             has_table_privilege('reporting_rls', 'public.audit_account_state', 'update') as update,
             has_table_privilege('reporting_rls', 'public.audit_account_state', 'delete') as delete
    `;
    expect(reportingState[0]).toEqual({
      select: false,
      insert: false,
      update: false,
      delete: false,
    });

    for (const role of ["api_rls", "worker_rls", "audit_system"] as const) {
      const [sequence] = await db`
        select has_sequence_privilege(${role}, 'public.audit_event_chain_seq', 'USAGE') as usage,
               has_sequence_privilege(${role}, 'public.audit_event_chain_seq', 'SELECT') as select,
               has_sequence_privilege(${role}, 'public.audit_event_chain_seq', 'UPDATE') as update
      `;
      expect(sequence, `${role}/audit_event_chain_seq`).toEqual({
        usage: true,
        select: false,
        update: false,
      });
    }
    const [reportingSequence] = await db`
      select has_sequence_privilege('reporting_rls', 'public.audit_event_chain_seq', 'USAGE') as usage,
             has_sequence_privilege('reporting_rls', 'public.audit_event_chain_seq', 'SELECT') as select
    `;
    expect(reportingSequence).toEqual({ usage: false, select: false });

    const auditInsertColumns = [
      "id",
      "account_id",
      "assessment_id",
      "job_id",
      "actor",
      "action",
      "prev_event_id",
      "payload_json",
    ];
    for (const role of ["api_rls", "worker_rls", "audit_system"] as const) {
      for (const column of [...auditInsertColumns, "chain_seq", "created_at"] as const) {
        const [privilege] = await db`
          select has_column_privilege(${role}, 'public.audit_event', ${column}, 'insert') as allowed
        `;
        expect(privilege?.allowed, `${role}/audit_event/${column}/insert`).toBe(
          auditInsertColumns.includes(column),
        );
      }
    }

    for (const table of TENANT_TABLES) {
      const reporting = await db`
        select has_table_privilege('reporting_rls', ${table}, 'select') as select,
               has_table_privilege('reporting_rls', ${table}, 'insert') as insert,
               has_table_privilege('reporting_rls', ${table}, 'update') as update,
               has_table_privilege('reporting_rls', ${table}, 'delete') as delete
      `;
      expect(reporting[0]?.select).toBe(table !== "credential" && table !== "session");
      expect(reporting[0]?.insert).toBe(false);
      expect(reporting[0]?.update).toBe(false);
      expect(reporting[0]?.delete).toBe(false);
    }
  });

  it("allows the SECURITY DEFINER migration owner to evaluate bootstrap audit policies", async () => {
    const [owner] = await db`select current_user::text as role`;
    const [helper] = await db`
      select has_function_privilege(${owner?.role}, 'public.rls_bootstrap_context()', 'execute') as allowed
    `;
    expect(helper?.allowed).toBe(true);
    const policies = await db`
      select c.relname, p.polname,
             array(select r.rolname from pg_roles r where r.oid = any(p.polroles) order by r.rolname) as roles
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      where p.polname in ('audit_event_bootstrap', 'audit_account_state_bootstrap')
      order by p.polname
    `;
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect(policy.roles).toEqual(expect.arrayContaining(["auth_bootstrap", owner?.role]));
    }
  });

  it("enables and forces RLS on every tenant table with explicit policies", async () => {
    const rows = await db`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
             count(p.polname)::int as policy_count
      from pg_class c
      left join pg_policy p on p.polrelid = c.oid
      where c.relnamespace = 'public'::regnamespace
        and c.relname = any(${TENANT_TABLES}::text[])
      group by c.relname, c.relrowsecurity, c.relforcerowsecurity
      order by c.relname
    `;
    expect(rows).toHaveLength(TENANT_TABLES.length);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
      const expectedCount =
        row.relname === "audit_event"
          ? 8
          : ["assessment", "job"].includes(String(row.relname))
            ? 4
            : ["account", "user", "session"].includes(String(row.relname))
              ? 4
              : 3;
      expect(Number(row.policy_count)).toBe(expectedCount);
    }
    const [state] = await db`
      select c.relrowsecurity, c.relforcerowsecurity, count(p.polname)::int as policy_count
      from pg_class c left join pg_policy p on p.polrelid = c.oid
      where c.oid = 'public.audit_account_state'::regclass
      group by c.relrowsecurity, c.relforcerowsecurity
    `;
    expect(state).toEqual({ relrowsecurity: true, relforcerowsecurity: true, policy_count: 5 });
  });

  it("catalogues policy commands and tenant predicates without command widening", async () => {
    const policies = await db`
      select c.relname, p.polname, p.polcmd,
             array(select r.rolname from pg_roles r where r.oid = any(p.polroles) order by r.rolname) as roles,
             pg_get_expr(p.polqual, p.polrelid) as using_expr,
             pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      where c.relnamespace = 'public'::regnamespace
        and c.relname = any(${[...TENANT_TABLES, AUDIT_STATE_TABLE]}::text[])
    `;
    const byName = new Map(policies.map((policy) => [policy.polname, policy]));
    const expectedNames = new Set<string>();
    for (const table of TENANT_TABLES) {
      for (const role of ["api_rls", "worker_rls"]) {
        const policy = byName.get(`${table}_${role}_tenant`);
        expectedNames.add(`${table}_${role}_tenant`);
        const selectOnly = ["audit_event", "billing_event", "credit_entry", "entitlement"].includes(
          table,
        );
        expect(policy?.polcmd, `${table}/${role}`).toBe(selectOnly ? "r" : "*");
        expect(policy?.roles, `${table}/${role}/roles`).toEqual([role]);
        const tenantColumn = table === "account" ? "id" : "account_id";
        const expectedUsing = ["billing_event", "credit_entry", "entitlement"].includes(table)
          ? `rls_tenant_matches(${tenantColumn})`
          : `rls_tenant_matches(${tenantColumn}) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL`;
        expect(normalizePolicyExpression(policy?.using_expr), `${table}/${role}/using`).toBe(
          expectedUsing,
        );
        expect(normalizePolicyExpression(policy?.check_expr), `${table}/${role}/check`).toBe(
          selectOnly ? "" : expectedUsing,
        );
      }
      const reporting = byName.get(`${table}_reporting_rls_tenant`);
      expectedNames.add(`${table}_reporting_rls_tenant`);
      expect(reporting?.polcmd, `${table}/reporting`).toBe("r");
      expect(reporting?.roles, `${table}/reporting/roles`).toEqual(["reporting_rls"]);
      const tenantColumn = table === "account" ? "id" : "account_id";
      expect(normalizePolicyExpression(reporting?.using_expr)).toBe(
        ["billing_event", "credit_entry", "entitlement"].includes(table)
          ? `rls_tenant_matches(${tenantColumn})`
          : `rls_tenant_matches(${tenantColumn}) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL`,
      );
      expect(normalizePolicyExpression(reporting?.check_expr)).toBe("");
    }
    for (const name of ["audit_event_api_rls_insert", "audit_event_worker_rls_insert"]) {
      expectedNames.add(name);
      expect(byName.get(name)?.polcmd).toBe("a");
      expect(byName.get(name)?.roles).toEqual([name.includes("api") ? "api_rls" : "worker_rls"]);
      expect(normalizePolicyExpression(byName.get(name)?.using_expr)).toBe("");
      expect(normalizePolicyExpression(byName.get(name)?.check_expr)).toBe(
        "rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL",
      );
    }
    for (const name of ["audit_event_audit_system_select", "audit_event_audit_system_insert"]) {
      expectedNames.add(name);
      const policy = byName.get(name);
      expect(policy?.roles).toEqual(["audit_system"]);
      expect(policy?.polcmd).toBe(name.endsWith("select") ? "r" : "a");
    }
    for (const table of ["account", "user", "session", "audit_event"]) {
      expectedNames.add(`${table}_bootstrap`);
      expect(byName.get(`${table}_bootstrap`)?.polcmd).toBe("*");
      expect(normalizePolicyExpression(byName.get(`${table}_bootstrap`)?.using_expr)).toBe(
        "rls_bootstrap_context()",
      );
      expect(normalizePolicyExpression(byName.get(`${table}_bootstrap`)?.check_expr)).toBe(
        "rls_bootstrap_context()",
      );
    }
    for (const role of ["api_rls", "worker_rls"] as const) {
      const policy = byName.get(`audit_account_state_${role}_tenant`);
      expectedNames.add(`audit_account_state_${role}_tenant`);
      expect(policy?.polcmd, `${role}/audit_account_state`).toBe("r");
      expect(policy?.roles).toEqual([role]);
      expect(normalizePolicyExpression(policy?.using_expr)).toBe(
        "rls_tenant_matches(account_id) AND NULLIF(current_setting('app.tenant', true), '') IS NOT NULL",
      );
      const lock = byName.get(`audit_account_state_${role}_lock`);
      expectedNames.add(`audit_account_state_${role}_lock`);
      expect(lock?.polcmd, `${role}/audit_account_state lock`).toBe("w");
      expect(lock?.roles).toEqual([role]);
    }
    expectedNames.add("audit_account_state_bootstrap");
    expect(byName.get("audit_account_state_bootstrap")?.polcmd).toBe("*");
    for (const name of ["assessment_queue_control", "job_queue_control"]) {
      expectedNames.add(name);
      expect(byName.get(name)?.polcmd).toBe("*");
      expect(byName.get(name)?.roles).toEqual(["queue_control"]);
    }
    expect([...byName.keys()].sort()).toEqual([...expectedNames].sort());
  });

  it("exposes only the exact auth function signatures to auth_bootstrap", async () => {
    const rows = await db`
      select p.proname, oidvectortypes(p.proargtypes) as args,
             p.prosecdef, p.proconfig,
             has_function_privilege('public', p.oid, 'execute') as public_execute,
             has_function_privilege('api_rls', p.oid, 'execute') as api_execute,
             has_function_privilege('worker_rls', p.oid, 'execute') as worker_execute,
             has_function_privilege('reporting_rls', p.oid, 'execute') as reporting_execute,
             has_function_privilege('queue_control', p.oid, 'execute') as queue_control_execute,
             has_function_privilege('queue_connector', p.oid, 'execute') as queue_connector_execute,
             has_function_privilege('admin_queue_connector', p.oid, 'execute') as admin_queue_execute,
             has_function_privilege('auth_bootstrap', p.oid, 'execute') as bootstrap_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any(${AUTH_FUNCTIONS.map(([name]) => name)}::text[])
      order by p.proname, args
    `;
    expect(rows).toHaveLength(AUTH_FUNCTIONS.length);
    for (const [name, args] of AUTH_FUNCTIONS) {
      const row = rows.find((candidate) => candidate.proname === name);
      expect(row?.args?.replaceAll(" ", "")).toBe(args.replaceAll(" ", ""));
      expect(row?.prosecdef).toBe(true);
      expect(row?.proconfig).toContain("search_path=pg_catalog, public");
      expect(row?.public_execute).toBe(false);
      expect(row?.api_execute).toBe(false);
      expect(row?.worker_execute).toBe(false);
      expect(row?.reporting_execute).toBe(false);
      expect(row?.queue_control_execute).toBe(false);
      expect(row?.queue_connector_execute).toBe(false);
      expect(row?.admin_queue_execute).toBe(false);
      expect(row?.bootstrap_execute).toBe(true);
    }
  });

  it("grants tenant helper execution only to runtime policy roles", async () => {
    const rows = await db`
      select p.proname, oidvectortypes(p.proargtypes) as args,
             has_function_privilege('public', p.oid, 'execute') as public_execute,
             has_function_privilege('api_rls', p.oid, 'execute') as api_execute,
             has_function_privilege('worker_rls', p.oid, 'execute') as worker_execute,
             has_function_privilege('reporting_rls', p.oid, 'execute') as reporting_execute,
             has_function_privilege('auth_bootstrap', p.oid, 'execute') as bootstrap_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('rls_tenant_matches', 'rls_bootstrap_context')
      order by p.proname
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.public_execute).toBe(false);
      expect(row.api_execute).toBe(true);
      expect(row.worker_execute).toBe(true);
      expect(row.reporting_execute).toBe(true);
      expect(row.bootstrap_execute).toBe(false);
    }
  });

  it("bootstraps Google identities by subject and manages opaque sessions atomically", async () => {
    await db
      .begin(async (tx) => {
        await tx.unsafe("set local role auth_bootstrap");
        const expiry = new Date(Date.now() + 60 * 60 * 1000);
        const subjectPrefix = `google-${randomUUID()}`;
        const hashA = sha256(`${subjectPrefix}-token-a`);
        const hashB = sha256(`${subjectPrefix}-token-b`);
        const hashC = sha256(`${subjectPrefix}-token-c`);
        const hashRotated = sha256(`${subjectPrefix}-token-rotated`);
        const [first] = await tx`
        select * from public.auth_complete_google_login(
          ${`${subjectPrefix}-a`}, 'same@example.test'::citext, ${hashA}, ${expiry}, '127.0.0.1'::inet, 'test'
        )
      `;
        const [sameSubject] = await tx`
        select * from public.auth_complete_google_login(
          ${`${subjectPrefix}-a`}, 'changed@example.test'::citext, ${hashB}, ${expiry}, '127.0.0.1'::inet, 'test'
        )
      `;
        const [differentSubject] = await tx`
        select * from public.auth_complete_google_login(
          ${`${subjectPrefix}-b`}, 'changed@example.test'::citext, ${hashC}, ${expiry}, '127.0.0.1'::inet, 'test'
        )
      `;
        expect(sameSubject?.account_id).toBe(first?.account_id);
        expect(sameSubject?.user_id).toBe(first?.user_id);
        expect(differentSubject?.account_id).not.toBe(first?.account_id);
        expect(differentSubject?.user_id).not.toBe(first?.user_id);

        const [resolved] = await tx`
        select * from public.auth_resolve_session(${hashB})
      `;
        expect(resolved?.session_id).toBe(sameSubject?.session_id);
        expect(resolved).not.toHaveProperty("token_hash");

        const [rotated] = await tx`
        select * from public.auth_rotate_session(${hashB}, ${hashRotated}, ${expiry})
      `;
        expect(rotated?.session_id).not.toBe(sameSubject?.session_id);
        expect(await tx`select * from public.auth_resolve_session(${hashB})`).toEqual([]);
        expect(await tx`select * from public.auth_resolve_session(${hashRotated})`).toHaveLength(1);

        expect(
          await tx`select * from public.auth_complete_google_login(
        'expired-subject', 'expired@example.test'::citext, ${sha256("expired-token")}, now() - interval '1 minute', null, null
      )`,
        ).toEqual([]);
        await tx`select public.auth_revoke_session(${hashRotated})`;
        expect(await tx`select * from public.auth_resolve_session(${hashRotated})`).toEqual([]);

        await tx.unsafe("reset role");
        const audit = await tx`select count(*)::int as count from public.audit_event`;
        expect(Number(audit[0]?.count)).toBe(3);
        expect(await tx`select count(*)::int as count from public.entitlement`).toEqual([
          { count: 0 },
        ]);
        expect(await tx`select count(*)::int as count from public.credit_entry`).toEqual([
          { count: 0 },
        ]);
        throw new Error("rollback auth fixture");
      })
      .catch((error) => {
        expect(error.message).toBe("rollback auth fixture");
      });
  });

  it("serializes family rotation and logout so old-hash logout revokes replacement", async () => {
    const rotateDb = createRawDbConnection(databaseUrlForTest());
    const revokeDb = createRawDbConnection(databaseUrlForTest());
    const run = randomUUID();
    const firstHash = sha256(`concurrent-first-${run}`);
    const replacementHash = sha256(`concurrent-replacement-${run}`);
    let accountId: string | undefined;
    try {
      const [created] = await db.begin(async (tx) => {
        await tx.unsafe("set local role auth_bootstrap");
        return tx`select * from public.auth_complete_google_login(
          ${`concurrent-${run}`}, ${`concurrent-${run}@example.test`}::citext, ${firstHash}, now() + interval '1 hour', null, null
        )`;
      });
      if (!created) throw new Error("concurrency fixture missing");
      accountId = created.account_id;

      await Promise.all([
        rotateDb.begin(async (tx) => {
          await tx.unsafe("set local role auth_bootstrap");
          return tx`select * from public.auth_rotate_session(
            ${firstHash}, ${replacementHash}, now() + interval '1 hour'
          )`;
        }),
        revokeDb.begin(async (tx) => {
          await tx.unsafe("set local role auth_bootstrap");
          return tx`select public.auth_revoke_session(${firstHash})`;
        }),
      ]);

      const resolved = await db.begin(async (tx) => {
        await tx.unsafe("set local role auth_bootstrap");
        return tx`select * from public.auth_resolve_session(${replacementHash})`;
      });
      expect(resolved).toEqual([]);
      const oldResolved = await db.begin(async (tx) => {
        await tx.unsafe("set local role auth_bootstrap");
        return tx`select * from public.auth_resolve_session(${firstHash})`;
      });
      expect(oldResolved).toEqual([]);
    } finally {
      const cleanupAccountId = accountId;
      if (cleanupAccountId) {
        await db.begin(async (tx) => {
          await tx.unsafe("reset role");
          await tx`delete from public.session where account_id = ${cleanupAccountId}`;
          await tx`delete from public.audit_event where account_id = ${cleanupAccountId}`;
          await tx`delete from public.account_membership where account_id = ${cleanupAccountId}`;
          await tx`delete from public."user" where account_id = ${cleanupAccountId}`;
          await tx`delete from public.queue_tenant_state where account_id = ${cleanupAccountId}`;
          await tx`delete from public.account where id = ${cleanupAccountId}`;
        });
      }
      await rotateDb.end();
      await revokeDb.end();
    }
  });

  it("rejects raw, blank, non-hex, and non-canonical session hashes without side effects", async () => {
    await db
      .begin(async (tx) => {
        await tx.unsafe("set local role auth_bootstrap");
        const invalid = ["raw-token", "", "a".repeat(63), "a".repeat(65), "g".repeat(64)];
        const subjectPrefix = `invalid-${randomUUID()}`;
        for (const [index, value] of invalid.entries()) {
          expect(
            await tx`select * from public.auth_complete_google_login(
              ${`${subjectPrefix}-${index}`}, 'invalid@example.test'::citext, ${value}, now() + interval '1 hour', null, null
            )`,
          ).toEqual([]);
          expect(await tx`select * from public.auth_resolve_session(${value})`).toEqual([]);
          expect(
            await tx`select * from public.auth_rotate_session(${value}, ${sha256(`replacement-${index}`)}, now() + interval '1 hour')`,
          ).toEqual([]);
          expect(await tx`select public.auth_revoke_session(${value})`).toEqual([
            { auth_revoke_session: false },
          ]);
        }
        await tx.unsafe("reset role");
        expect(await tx`select count(*)::int as count from public.account`).toEqual([{ count: 0 }]);
        expect(await tx`select count(*)::int as count from public.session`).toEqual([{ count: 0 }]);
        expect(await tx`select count(*)::int as count from public.audit_event`).toEqual([
          { count: 0 },
        ]);
        throw new Error("rollback invalid hash fixture");
      })
      .catch((error) => {
        expect(error.message).toBe("rollback invalid hash fixture");
      });
  });

  it("does not relogin Google subjects on revoked, deleted, or inconsistent accounts", async () => {
    await db
      .begin(async (tx) => {
        for (const scenario of [
          { name: "revoked", status: "revoked", deletedAt: false },
          { name: "deleted", status: "deleted", deletedAt: true },
          { name: "active-deleted-at", status: "active", deletedAt: true },
        ]) {
          const run = randomUUID();
          const firstHash = sha256(`${scenario.name}-first-${run}`);
          const secondHash = sha256(`${scenario.name}-second-${run}`);
          const subject = `${scenario.name}-${randomUUID()}`;
          await tx.unsafe("set local role auth_bootstrap");
          const [first] = await tx`select * from public.auth_complete_google_login(
            ${subject}, ${`before-${scenario.name}@example.test`}::citext, ${firstHash}, now() + interval '1 hour', null, null
          )`;
          if (!first) throw new Error(`${scenario.name} fixture missing`);
          await tx.unsafe("reset role");
          if (scenario.deletedAt) {
            await tx`update public.account set status = ${scenario.status}, deleted_at = now() where id = ${first.account_id}`;
          } else {
            await tx`update public.account set status = ${scenario.status} where id = ${first.account_id}`;
          }
          const before =
            await tx`select u.email, count(s.id)::int as sessions, count(a.id)::int as audits
            from public."user" u
            left join public.session s on s.user_id = u.id
            left join public.audit_event a on a.account_id = u.account_id
            where u.id = ${first.user_id}
            group by u.email`;
          await tx.unsafe("set local role auth_bootstrap");
          expect(
            await tx`select * from public.auth_complete_google_login(
              ${subject}, ${`after-${scenario.name}@example.test`}::citext, ${secondHash}, now() + interval '1 hour', null, null
            )`,
          ).toEqual([]);
          await tx.unsafe("reset role");
          const after =
            await tx`select u.email, count(s.id)::int as sessions, count(a.id)::int as audits
            from public."user" u
            left join public.session s on s.user_id = u.id
            left join public.audit_event a on a.account_id = u.account_id
            where u.id = ${first.user_id}
            group by u.email`;
          expect(after).toEqual(before);
        }
        throw new Error("rollback revoked fixture");
      })
      .catch((error) => {
        expect(error.message).toBe("rollback revoked fixture");
      });
  });
});
