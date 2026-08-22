import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbConnection, type DbConnection } from "../src/index";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const describeDb = RUN_DB_TESTS ? describe : describe.skip;
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
const AUTH_FUNCTIONS = [
  ["auth_complete_google_login", "text,citext,text,timestamp with time zone,inet,text"],
  ["auth_resolve_session", "text"],
  ["auth_rotate_session", "text,text,timestamp with time zone"],
  ["auth_revoke_session", "text"],
] as const;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for PostgreSQL isolation tests");
  const database = new URL(value).pathname.slice(1);
  if (!database.endsWith("_test")) throw new Error(`Refusing non-test database: ${database}`);
  return value;
}

describeDb("PostgreSQL least-privilege roles", () => {
  let db!: DbConnection;

  beforeAll(() => {
    db = createDbConnection(databaseUrlForTest());
  });
  afterAll(async () => db?.end());

  it("creates non-login, non-owner, non-inheriting, non-bypass runtime roles", async () => {
    const rows = await db`
      select rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin
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
    }

    const owners = await db`
      select distinct r.rolname
      from pg_roles r
      join pg_class c on c.relowner = r.oid
      where c.relnamespace = 'public'::regnamespace
        and r.rolname in ('api_rls', 'worker_rls', 'reporting_rls', 'auth_bootstrap')
    `;
    expect(owners).toEqual([]);
  });

  it("keeps auth bootstrap without direct table DML and grants explicit runtime access", async () => {
    for (const table of TENANT_TABLES) {
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
    expect(auditApi[0]).toEqual({ select: true, insert: true, update: false, delete: false });

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
      expect(Number(row.policy_count)).toBeGreaterThanOrEqual(3);
      if (["account", "user", "session", "audit_event"].includes(String(row.relname))) {
        expect(Number(row.policy_count)).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("catalogues policy commands and tenant predicates without command widening", async () => {
    const policies = await db`
      select c.relname, p.polname, p.polcmd,
             pg_get_expr(p.polqual, p.polrelid) as using_expr,
             pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      where c.relnamespace = 'public'::regnamespace
        and c.relname = any(${TENANT_TABLES}::text[])
    `;
    const byName = new Map(policies.map((policy) => [policy.polname, policy]));
    for (const table of TENANT_TABLES) {
      for (const role of ["api_rls", "worker_rls"]) {
        const policy = byName.get(`${table}_${role}_tenant`);
        expect(policy?.polcmd, `${table}/${role}`).toBe(table === "audit_event" ? "r" : "*");
        expect(policy?.using_expr).toContain("rls_tenant_matches");
        if (table !== "audit_event") expect(policy?.check_expr).toContain("rls_tenant_matches");
      }
      const reporting = byName.get(`${table}_reporting_rls_tenant`);
      expect(reporting?.polcmd, `${table}/reporting`).toBe("r");
      expect(reporting?.using_expr).toContain("rls_tenant_matches");
    }
    expect(byName.get("audit_event_api_rls_insert")?.polcmd).toBe("a");
    expect(byName.get("audit_event_worker_rls_insert")?.polcmd).toBe("a");
    for (const table of ["account", "user", "session", "audit_event"]) {
      expect(byName.get(`${table}_bootstrap`)?.polcmd).toBe("*");
    }
    expect([...byName.keys()].filter((name) => name.endsWith("_bootstrap"))).toHaveLength(4);
  });

  it("exposes only the exact auth function signatures to auth_bootstrap", async () => {
    const rows = await db`
      select p.proname, oidvectortypes(p.proargtypes) as args,
             p.prosecdef, p.proconfig,
             has_function_privilege('public', p.oid, 'execute') as public_execute,
             has_function_privilege('api_rls', p.oid, 'execute') as api_execute,
             has_function_privilege('worker_rls', p.oid, 'execute') as worker_execute,
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
      expect(row?.bootstrap_execute).toBe(true);
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
        expect(rotated?.session_id).toBe(sameSubject?.session_id);
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
