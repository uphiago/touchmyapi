import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  createDbConnection,
  withTenant,
  type DbConnection,
  type RuntimeRole,
  type TenantConnection,
} from "../src/index";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  const database = new URL(value).pathname.slice(1);
  if (!database.endsWith("_test")) throw new Error(`Refusing non-test database: ${database}`);
  if (new URL(value).hostname !== "127.0.0.1") {
    throw new Error("Refusing database outside 127.0.0.1 for integration tests");
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

type Fixture = {
  accountA: string;
  accountB: string;
  sessionA: string;
  sessionB: string;
  userA: string;
  userB: string;
  assessmentA: string;
  assessmentB: string;
  credentialA: string;
  credentialB: string;
  findingA: string;
  findingB: string;
  auditA: string;
  auditB: string;
  playbookKey: string;
};

async function createFixture(db: DbConnection): Promise<Fixture> {
  const run = randomUUID();
  return db.begin(async (tx) => {
    await tx.unsafe("set local role auth_bootstrap");
    const [accountA] = await tx`select * from public.auth_complete_google_login(
      ${`tenant-session-a-${run}`}, ${`a-${run}@example.test`}::citext,
      ${run.replaceAll("-", "") + "a".repeat(32)}, now() + interval '1 hour', null, null
    )`;
    const [accountB] = await tx`select * from public.auth_complete_google_login(
      ${`tenant-session-b-${run}`}, ${`b-${run}@example.test`}::citext,
      ${run.replaceAll("-", "") + "b".repeat(32)}, now() + interval '1 hour', null, null
    )`;
    if (!accountA || !accountB) throw new Error("auth fixture missing");
    await tx.unsafe("reset role");
    const playbookKey = `tenant-session-${run}`;
    await tx`insert into public.playbook
      (key, playbook_version, target_category, contract_json)
      values (${playbookKey}, '1.0.0', 'surface', '{}'::jsonb)`;

    const insertAssessment = (accountId: string) => tx`insert into public.assessment
      (account_id, target_category, target_json, scope_json, playbook_id, playbook_version, limits_json)
      values (${accountId}, 'surface', '{}'::jsonb, '{}'::jsonb, ${playbookKey}, '1.0.0', '{}'::jsonb)
      returning id`;
    const [assessmentA] = await insertAssessment(accountA.account_id);
    const [assessmentB] = await insertAssessment(accountB.account_id);
    if (!assessmentA || !assessmentB) throw new Error("assessment fixture missing");

    const insertCredential = (
      accountId: string,
      assessmentId: string,
    ) => tx`insert into public.credential
      (account_id, assessment_id, encrypted_payload, key_id, purpose)
      values (${accountId}, ${assessmentId}, decode('00', 'hex'), 'fixture', 'fixture') returning id`;
    const [credentialA] = await insertCredential(accountA.account_id, assessmentA.id);
    const [credentialB] = await insertCredential(accountB.account_id, assessmentB.id);
    if (!credentialA || !credentialB) throw new Error("credential fixture missing");

    const insertFinding = (accountId: string, assessmentId: string) => tx`insert into public.finding
      (account_id, assessment_id, title, category, severity)
      values (${accountId}, ${assessmentId}, 'fixture', 'fixture', 'low') returning id`;
    const [findingA] = await insertFinding(accountA.account_id, assessmentA.id);
    const [findingB] = await insertFinding(accountB.account_id, assessmentB.id);
    if (!findingA || !findingB) throw new Error("finding fixture missing");

    const insertAudit = (accountId: string) => tx`insert into public.audit_event
      (account_id, actor, action, payload_json)
      values (${accountId}, 'fixture', 'request', '{}'::jsonb) returning id`;
    const [auditA] = await insertAudit(accountA.account_id);
    const [auditB] = await insertAudit(accountB.account_id);
    if (!auditA || !auditB) throw new Error("audit fixture missing");

    return {
      accountA: accountA.account_id,
      accountB: accountB.account_id,
      sessionA: accountA.session_id,
      sessionB: accountB.session_id,
      userA: accountA.user_id,
      userB: accountB.user_id,
      assessmentA: assessmentA.id,
      assessmentB: assessmentB.id,
      credentialA: credentialA.id,
      credentialB: credentialB.id,
      findingA: findingA.id,
      findingB: findingB.id,
      auditA: auditA.id,
      auditB: auditB.id,
      playbookKey,
    };
  });
}

async function expectHiddenOrDenied(
  connection: DbConnection,
  accountId: string,
  operation: (tenant: TenantConnection) => Promise<unknown>,
): Promise<void> {
  try {
    const result = await withTenant(connection, accountId, "api_rls", operation);
    expect(result).toEqual([]);
  } catch (error: unknown) {
    const pgError = error as { code?: string; message?: string };
    expect(["42501", "23503"]).toContain(pgError.code);
    expect(pgError.message).toMatch(/permission denied|row-level security|foreign key/i);
  }
}

async function expectCountHiddenOrDenied(
  connection: DbConnection,
  accountId: string,
  operation: (tenant: TenantConnection) => Promise<unknown>,
): Promise<void> {
  try {
    const result = (await withTenant(connection, accountId, "api_rls", operation)) as Array<{
      count?: number | string;
    }>;
    expect(result).toHaveLength(1);
    expect(Number(result[0]?.count)).toBe(0);
  } catch (error: unknown) {
    const pgError = error as { code?: string; message?: string };
    expect(pgError.code).toBe("42501");
    expect(pgError.message).toMatch(/permission denied|row-level security/i);
  }
}

describe.skipIf(!RUN_DB_TESTS)("withTenant", () => {
  let adminDb!: DbConnection;
  let db!: DbConnection;
  let fixture!: Fixture;
  let connectorRole = "";
  let connectorPassword = "";

  async function expectCleanBorrowedConnection(): Promise<void> {
    const [state] =
      await db`select current_user as role, current_setting('app.tenant', true) as tenant`;
    expect(state?.role).toBe(connectorRole);
    expect(state?.tenant ?? "").toBe("");
  }

  async function expectNoTemporaryTable(tableName: string): Promise<void> {
    const [row] = await db`
      select exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname like 'pg_temp_%' and c.relname = ${tableName}
      ) as present
    `;
    expect(row?.present).toBe(false);
  }

  beforeAll(async () => {
    const databaseUrl = databaseUrlForTest();
    adminDb = createDbConnection(databaseUrl);
    connectorRole = `tma_t016_${randomUUID().replaceAll("-", "")}`;
    connectorPassword = randomUUID().replaceAll("-", "");
    const roleIdentifier = quoteIdentifier(connectorRole);
    await adminDb.unsafe(
      `create role ${roleIdentifier} login noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password ${sqlStringLiteral(connectorPassword)}`,
    );
    await adminDb.unsafe(`grant api_rls, worker_rls, reporting_rls to ${roleIdentifier}`);
    fixture = await createFixture(adminDb);
    const connectorUrl = new URL(databaseUrl);
    connectorUrl.username = connectorRole;
    connectorUrl.password = connectorPassword;
    db = postgres(connectorUrl.toString(), { max: 1 }) as DbConnection;
  });

  afterAll(async () => {
    try {
      await db?.end();
    } finally {
      try {
        if (fixture) {
          await adminDb.begin(async (tx) => {
            for (const table of [
              "audit_event",
              "credential",
              "finding",
              "assessment",
              "session",
              '"user"',
            ]) {
              await tx.unsafe(`delete from public.${table} where account_id in ($1, $2)`, [
                fixture.accountA,
                fixture.accountB,
              ]);
            }
            await tx.unsafe("delete from public.account where id in ($1, $2)", [
              fixture.accountA,
              fixture.accountB,
            ]);
            await tx.unsafe("delete from public.playbook where key = $1", [fixture.playbookKey]);
          });
        }
      } finally {
        try {
          if (connectorRole) {
            await adminDb.unsafe(`drop role ${quoteIdentifier(connectorRole)}`);
          }
        } finally {
          await adminDb?.end();
        }
      }
    }
  });

  it("scopes reads and own mutations while hiding every other account", async () => {
    let own!: {
      accountRows: Array<{ id: string }>;
      assessmentRows: Array<{ id: string }>;
      credentialRows: Array<{ id: string }>;
      findingRows: Array<{ id: string }>;
      auditRows: Array<{ id: string }>;
      ownInsert: Array<{ id: string }>;
      update: Array<{ id: string }>;
      deleteOwn: Array<{ id: string }>;
    };
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        const accountRows = await tenant.unsafe<{ id: string }>(
          "select id from public.account order by id",
        );
        const assessmentRows = await tenant.unsafe<{ id: string }>(
          "select id from public.assessment order by id",
        );
        const credentialRows = await tenant.unsafe<{ id: string }>(
          "select id from public.credential order by id",
        );
        const findingRows = await tenant.unsafe<{ id: string }>(
          "select id from public.finding order by id",
        );
        const auditRows = await tenant.unsafe<{ id: string }>(
          "select id from public.audit_event order by id",
        );
        const ownInsert = await tenant.unsafe<{ id: string }>(
          "insert into public.assessment (account_id, target_category, target_json, scope_json, playbook_id, playbook_version, limits_json) values ($1, 'surface', '{}'::jsonb, '{}'::jsonb, $2, '1.0.0', '{}'::jsonb) returning id",
          [fixture.accountA, fixture.playbookKey],
        );
        const update = await tenant.unsafe<{ id: string }>(
          "update public.assessment set status = 'queued' where id = $1 returning id",
          [fixture.assessmentA],
        );
        const deleteOwn = await tenant.unsafe<{ id: string }>(
          "delete from public.credential where id = $1 returning id",
          [fixture.credentialA],
        );
        own = {
          accountRows,
          assessmentRows,
          credentialRows,
          findingRows,
          auditRows,
          ownInsert,
          update,
          deleteOwn,
        };
        throw new Error("rollback own mutations");
      }),
    ).rejects.toThrow("rollback own mutations");

    expect(own.accountRows.map((row) => row.id)).toEqual([fixture.accountA]);
    expect(own.assessmentRows.map((row) => row.id)).toEqual([fixture.assessmentA]);
    expect(own.credentialRows.map((row) => row.id)).toEqual([fixture.credentialA]);
    expect(own.findingRows.map((row) => row.id)).toEqual([fixture.findingA]);
    expect(own.auditRows.map((row) => row.id)).toContain(fixture.auditA);
    expect(own.auditRows.map((row) => row.id)).not.toContain(fixture.auditB);
    expect(own.ownInsert).toHaveLength(1);
    expect(own.update).toHaveLength(1);
    expect(own.deleteOwn).toHaveLength(1);
  });

  it("rolls back callback failures and rejects invalid UUIDs and roles", async () => {
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        await tenant.unsafe("update public.assessment set status = 'running' where id = $1", [
          fixture.assessmentA,
        ]);
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");

    const [assessment] =
      await adminDb`select status from public.assessment where id = ${fixture.assessmentA}`;
    expect(assessment?.status).toBe("draft");
    await expectCleanBorrowedConnection();
    await expect(
      withTenant(db, "not-a-uuid", "api_rls", async () => "unreachable"),
    ).rejects.toThrow(/accountId.*UUID/i);
    await expect(
      withTenant(db, fixture.accountA, "invalid_role" as RuntimeRole, async () => "unreachable"),
    ).rejects.toThrow(/role/i);
  });

  it("rejects and rolls back when a callback catches a SQL error", async () => {
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        await tenant.unsafe("update public.assessment set status = 'running' where id = $1", [
          fixture.assessmentA,
        ]);
        try {
          await tenant.unsafe("select * from public.table_that_does_not_exist");
        } catch {
          return "caught";
        }
        return "not-caught";
      }),
    ).rejects.toThrow(/does not exist|current transaction is aborted/i);

    const [assessment] =
      await adminDb`select status from public.assessment where id = ${fixture.assessmentA}`;
    expect(assessment?.status).toBe("draft");
    await expectCleanBorrowedConnection();
  });

  it("blocks context, transaction, comments, quoting, and multi-statement escapes", async () => {
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      const rows = await tenant.unsafe<{ id: string }>(
        "WITH visible AS (SELECT id FROM public.account) SELECT id FROM visible",
      );
      expect(rows.map((row) => row.id)).toEqual([fixture.accountA]);

      const [operators] = await tenant.unsafe<{
        arrow: unknown;
        arrowText: unknown;
        hashArrow: unknown;
        hashArrowText: unknown;
        contains: boolean;
        contained: boolean;
        hasKey: boolean;
        hasAny: boolean;
        hasAll: boolean;
        regex: boolean;
      }>(
        "select '{}'::jsonb -> 'foo' as \"arrow\", '{}'::jsonb ->> 'foo' as \"arrowText\", '{}'::jsonb #> array['foo'] as \"hashArrow\", '{}'::jsonb #>> array['foo'] as \"hashArrowText\", '{}'::jsonb @> '{}'::jsonb as \"contains\", '{}'::jsonb <@ '{}'::jsonb as \"contained\", '{}'::jsonb ? 'foo' as \"hasKey\", '{}'::jsonb ?| array['foo'] as \"hasAny\", '{}'::jsonb ?& array['foo'] as \"hasAll\", 'fixture' ~ '^fix' as \"regex\"",
      );
      expect(operators).toMatchObject({
        contains: true,
        contained: true,
        hasKey: false,
        hasAny: false,
        hasAll: false,
        regex: true,
      });
    });

    const blockedStatements: Array<{ query: string; values?: unknown[] }> = [
      {
        query: "select set_config('app.tenant', $1, true)",
        values: [fixture.accountB],
      },
      {
        query: "SeLeCt pg_catalog.set_config('app.tenant', $1, true)",
        values: [fixture.accountB],
      },
      { query: "SELECT current_setting('app.tenant', true)" },
      { query: "SELECT/**/set_config('app.tenant', $1, true)", values: [fixture.accountB] },
      { query: 'SELECT "public"."set_config"($1)', values: [fixture.accountB] },
      { query: "SET ROLE worker_rls" },
      { query: "SET LOCAL ROLE worker_rls" },
      { query: "RESET ROLE" },
      { query: "COMMIT" },
      { query: "ROLLBACK" },
      { query: "SAVEPOINT escape_probe" },
      { query: "SELECT 1 INTO public.escape_probe" },
      { query: "SELECT 1; SELECT 2" },
      { query: "SELECT 1 -- set_config('app.tenant', 'B', true)" },
      { query: "SELECT $$; SET ROLE worker_rls; $$" },
      {
        query: "WITH escaped AS (SELECT 1) SELECT set_config('app.tenant', $1, true)",
        values: [fixture.accountB],
      },
    ];

    for (const statement of blockedStatements) {
      await expect(
        withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
          await tenant.unsafe("update public.assessment set status = 'running' where id = $1", [
            fixture.assessmentA,
          ]);
          await expect(tenant.unsafe(statement.query, statement.values)).rejects.toThrow(
            /blocked|forbidden|tenant|transaction|statement|query/i,
          );
          throw new Error("rollback blocked escape probe");
        }),
      ).rejects.toThrow(/rollback blocked escape probe|division by zero|aborted/i);
      const [assessment] =
        await adminDb`select status from public.assessment where id = ${fixture.assessmentA}`;
      expect(assessment?.status).toBe("draft");
      await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        const [account] = await tenant.unsafe<{ id: string }>("select id from public.account");
        expect(account?.id).toBe(fixture.accountA);
      });
      await expectCleanBorrowedConnection();
    }
  });

  it("rejects a privileged or table-owning connection before opening a tenant transaction", async () => {
    await expect(
      withTenant(adminDb, fixture.accountA, "api_rls", async () => "unreachable"),
    ).rejects.toThrow(/privileged|owner|connector/i);
  });

  it("rejects direct public function EXECUTE grants on the connector", async () => {
    const functionName = "public.rls_tenant_matches(uuid)";
    await adminDb.unsafe(
      `grant execute on function ${functionName} to ${quoteIdentifier(connectorRole)}`,
    );
    try {
      await expect(
        withTenant(db, fixture.accountA, "api_rls", async () => "unreachable"),
      ).rejects.toThrow(/function EXECUTE|direct public function/i);
    } finally {
      await adminDb.unsafe(
        `revoke execute on function ${functionName} from ${quoteIdentifier(connectorRole)}`,
      );
    }
  });

  it("rejects Unicode escape aliases before they can change tenant or role", async () => {
    const blockedStatements: Array<{ query: string; values?: unknown[] }> = [
      {
        query: 'select U&"set\\005fconfig"($1, $2, true)',
        values: ["app.tenant", fixture.accountB],
      },
      {
        query: 'select u&"set\\005fconfig"($1, $2, true)',
        values: ["role", "worker_rls"],
      },
      {
        query: "select U&'app!002Etenant' UESCAPE '!'",
      },
      {
        query: 'select u & "set\\005fconfig"($1, $2, true)',
        values: ["app.tenant", fixture.accountB],
      },
    ];

    for (const statement of blockedStatements) {
      await expect(
        withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
          await tenant.unsafe(statement.query, statement.values);
        }),
      ).rejects.toThrow(/blocked|Unicode|UESCAPE|forbidden/i);
      await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        const [account] = await tenant.unsafe<{ id: string }>("select id from public.account");
        expect(account?.id).toBe(fixture.accountA);
      });
      await expectCleanBorrowedConnection();
    }
  });

  it("rejects SELECT INTO at every nesting level and clears temporary state", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const statements = [
      `WITH source AS (SELECT 1) SELECT * INTO TEMP tma_temp_cte_${suffix} FROM source`,
      `SELECT * INTO TEMP tma_temp_subquery_${suffix} FROM (SELECT 1) AS source`,
      `WITH source AS (SELECT 1 INTO TEMP tma_temp_inner_${suffix}) SELECT * FROM source`,
      `SELECT "insert" INTO TEMP tma_temp_quoted_${suffix} FROM (SELECT 1 AS "insert") AS source`,
      "SELECT * FROM pg_temp.shadowed_table",
    ];

    for (const statement of statements) {
      await expect(
        withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
          await tenant.unsafe(statement);
        }),
      ).rejects.toThrow(/blocked|SELECT INTO|TEMP|temporary/i);
      await expectCleanBorrowedConnection();
    }

    await withTenant(db, fixture.accountB, "api_rls", async (tenant) => {
      const [account] = await tenant.unsafe<{ id: string }>("select id from public.account");
      expect(account?.id).toBe(fixture.accountB);
    });
    for (const tableName of [
      `tma_temp_cte_${suffix}`,
      `tma_temp_subquery_${suffix}`,
      `tma_temp_inner_${suffix}`,
      `tma_temp_quoted_${suffix}`,
    ]) {
      await expectNoTemporaryTable(tableName);
    }
  });

  it("rejects session-persistent and dangerous functions", async () => {
    const blockedStatements = [
      "select pg_sleep(0)",
      "select pg_sleep_for(interval '0 seconds')",
      "select pg_notify('tma_escape', 'blocked')",
      "select pg_advisory_lock(901016)",
      "select lo_import('/tmp/tma-escape')",
    ];

    for (const statement of blockedStatements) {
      try {
        await expect(
          withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
            await tenant.unsafe(statement);
          }),
        ).rejects.toThrow(/blocked|dangerous|forbidden|function/i);
      } finally {
        await db`select pg_advisory_unlock_all()`;
      }
      await expectCleanBorrowedConnection();
    }
  });

  it("allows data-modifying INSERT CTEs without allowing SELECT INTO", async () => {
    const [before] = await adminDb`
      select count(*)::int as count from public.audit_event where account_id = ${fixture.accountA}
    `;
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        const inserted = await tenant.unsafe<{ id: string }>(
          "WITH created AS (INSERT INTO public.audit_event (account_id, actor, action, payload_json) VALUES ($1, 'probe', 'request', '{}'::jsonb) RETURNING id) SELECT id FROM created",
          [fixture.accountA],
        );
        expect(inserted).toHaveLength(1);
        throw new Error("rollback insert CTE probe");
      }),
    ).rejects.toThrow("rollback insert CTE probe");
    const [after] = await adminDb`
      select count(*)::int as count from public.audit_event where account_id = ${fixture.accountA}
    `;
    expect(after?.count).toBe(before?.count);
  });

  it("rejects a runtime membership whose SET option is false", async () => {
    const restrictedRole = `tma_t016_set_false_${randomUUID().replaceAll("-", "")}`;
    const restrictedPassword = randomUUID().replaceAll("-", "");
    const roleIdentifier = quoteIdentifier(restrictedRole);
    let restrictedDb: DbConnection | undefined;
    try {
      await adminDb.unsafe(
        `create role ${roleIdentifier} login noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password ${sqlStringLiteral(restrictedPassword)}`,
      );
      await adminDb.unsafe(`grant api_rls to ${roleIdentifier} with set false`);
      const restrictedUrl = new URL(databaseUrlForTest());
      restrictedUrl.username = restrictedRole;
      restrictedUrl.password = restrictedPassword;
      restrictedDb = postgres(restrictedUrl.toString(), { max: 1 }) as DbConnection;

      await expect(
        withTenant(restrictedDb, fixture.accountA, "api_rls", async () => "unreachable"),
      ).rejects.toThrow(/SET FALSE|set_option|membership/i);
    } finally {
      try {
        await restrictedDb?.end();
      } finally {
        await adminDb.unsafe(`drop role ${roleIdentifier}`);
      }
    }
  });

  it("proves cross-tenant select, inference, DML, and foreign-key references fail closed", async () => {
    const ids: Record<string, string> = {
      account: fixture.accountB,
      session: fixture.sessionB,
      assessment: fixture.assessmentB,
      credential: fixture.credentialB,
      finding: fixture.findingB,
      audit_event: fixture.auditB,
    };
    const probe = (operation: (tenant: TenantConnection) => Promise<unknown>) =>
      expectHiddenOrDenied(db, fixture.accountA, operation);
    const countProbe = (operation: (tenant: TenantConnection) => Promise<unknown>) =>
      expectCountHiddenOrDenied(db, fixture.accountA, operation);

    for (const table of Object.keys(ids)) {
      await probe((tenant) =>
        tenant.unsafe(`select id from public."${table}" where id = $1`, [ids[table]]),
      );
      await countProbe((tenant) =>
        tenant.unsafe(`select count(*)::int as count from public."${table}" where id = $1`, [
          ids[table],
        ]),
      );
    }

    const inserts: Array<(tenant: TenantConnection) => Promise<unknown>> = [
      (tenant) =>
        tenant.unsafe("insert into public.account (status) values ('active') returning id"),
      (tenant) =>
        tenant.unsafe(
          "insert into public.session (account_id, user_id, family_id, token_hash, expires_at) values ($1, $2, gen_random_uuid(), $3, now() + interval '1 hour') returning id",
          [fixture.accountB, fixture.userB, "c".repeat(64)],
        ),
      (tenant) =>
        tenant.unsafe(
          "insert into public.assessment (account_id, target_category, target_json, scope_json, playbook_id, playbook_version, limits_json) values ($1, 'surface', '{}'::jsonb, '{}'::jsonb, $2, '1.0.0', '{}'::jsonb) returning id",
          [fixture.accountB, fixture.playbookKey],
        ),
      (tenant) =>
        tenant.unsafe(
          "insert into public.credential (account_id, assessment_id, encrypted_payload, key_id, purpose) values ($1, $2, decode('01', 'hex'), 'probe', 'probe') returning id",
          [fixture.accountB, fixture.assessmentB],
        ),
      (tenant) =>
        tenant.unsafe(
          "insert into public.finding (account_id, assessment_id, title, category, severity) values ($1, $2, 'probe', 'probe', 'low') returning id",
          [fixture.accountB, fixture.assessmentB],
        ),
      (tenant) =>
        tenant.unsafe(
          "insert into public.audit_event (account_id, actor, action, payload_json) values ($1, 'probe', 'request', '{}'::jsonb) returning id",
          [fixture.accountB],
        ),
    ];
    for (const insert of inserts) await probe(insert);

    const updates: Array<(tenant: TenantConnection) => Promise<unknown>> = [
      (tenant) =>
        tenant.unsafe(
          "update public.account set settings_ia_enabled = false where id = $1 returning id",
          [ids.account],
        ),
      (tenant) =>
        tenant.unsafe("update public.session set revoked_at = now() where id = $1 returning id", [
          ids.session,
        ]),
      (tenant) =>
        tenant.unsafe("update public.assessment set status = 'queued' where id = $1 returning id", [
          ids.assessment,
        ]),
      (tenant) =>
        tenant.unsafe("update public.credential set purpose = 'probe' where id = $1 returning id", [
          ids.credential,
        ]),
      (tenant) =>
        tenant.unsafe("update public.finding set title = 'probe' where id = $1 returning id", [
          ids.finding,
        ]),
      (tenant) =>
        tenant.unsafe("update public.audit_event set actor = 'probe' where id = $1 returning id", [
          ids.audit_event,
        ]),
    ];
    for (const update of updates) await probe(update);

    const deletes: Array<(tenant: TenantConnection) => Promise<unknown>> = [
      (tenant) =>
        tenant.unsafe("delete from public.account where id = $1 returning id", [ids.account]),
      (tenant) =>
        tenant.unsafe("delete from public.session where id = $1 returning id", [ids.session]),
      (tenant) =>
        tenant.unsafe("delete from public.assessment where id = $1 returning id", [ids.assessment]),
      (tenant) =>
        tenant.unsafe("delete from public.credential where id = $1 returning id", [ids.credential]),
      (tenant) =>
        tenant.unsafe("delete from public.finding where id = $1 returning id", [ids.finding]),
      (tenant) =>
        tenant.unsafe("delete from public.audit_event where id = $1 returning id", [
          ids.audit_event,
        ]),
    ];
    for (const remove of deletes) await probe(remove);

    await probe((tenant) =>
      tenant.unsafe(
        "insert into public.credential (account_id, assessment_id, encrypted_payload, key_id, purpose) values ($1, $2, decode('01', 'hex'), 'probe', 'cross-reference') returning id",
        [fixture.accountA, fixture.assessmentB],
      ),
    );
    await probe((tenant) =>
      tenant.unsafe(
        "insert into public.audit_event (account_id, assessment_id, actor, action, payload_json) values ($1, $2, 'probe', 'request', '{}'::jsonb) returning id",
        [fixture.accountA, fixture.assessmentB],
      ),
    );
  });

  it("rejects same-connection nesting and expires captured TenantConnections", async () => {
    let successfulCapture!: TenantConnection;
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      successfulCapture = tenant;
      await tenant.unsafe("select 1");
    });
    await expect(successfulCapture.unsafe("select 1")).rejects.toThrow(/no longer active/i);

    let callbackErrorCapture!: TenantConnection;
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        callbackErrorCapture = tenant;
        throw new Error("callback cleanup probe");
      }),
    ).rejects.toThrow("callback cleanup probe");
    await expect(callbackErrorCapture.unsafe("select 1")).rejects.toThrow(/no longer active/i);

    let captured!: TenantConnection;
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (outer) => {
        captured = outer;
        const [outerAccount] = await outer.unsafe<{ id: string }>("select id from public.account");
        expect(outerAccount?.id).toBe(fixture.accountA);
        await withTenant(db, fixture.accountB, "reporting_rls", async (inner) => {
          const [innerAccount] = await inner.unsafe<{ id: string }>(
            "select id from public.account",
          );
          expect(innerAccount?.id).toBe(fixture.accountB);
        });
      }),
    ).rejects.toThrow(/nested/i);
    await expect(captured.unsafe("select 1")).rejects.toThrow(/no longer active/i);

    let sqlErrorCapture!: TenantConnection;
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        sqlErrorCapture = tenant;
        await tenant.unsafe("select * from public.table_that_does_not_exist");
      }),
    ).rejects.toThrow(/does not exist/i);
    await expect(sqlErrorCapture.unsafe("select 1")).rejects.toThrow(/no longer active/i);
    const [state] =
      await db`select current_user as role, current_setting('app.tenant', true) as tenant`;
    expect(state?.role).toBe(connectorRole);
    expect(state?.tenant ?? "").toBe("");
  });

  it("leaves no tenant or runtime role on a borrowed connection and keeps reporting read-only", async () => {
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      await tenant.unsafe("select 1");
    });
    await expectCleanBorrowedConnection();

    await expect(
      withTenant(db, fixture.accountA, "reporting_rls", async (tenant) => {
        await tenant.unsafe("update public.finding set title = 'forbidden' where id = $1", [
          fixture.findingA,
        ]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("allows independent parallel requests while rejecting same-connection nesting", async () => {
    const [accountA, accountB] = await Promise.all([
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        const [account] = await tenant.unsafe<{ id: string }>("select id from public.account");
        return account?.id;
      }),
      withTenant(db, fixture.accountB, "reporting_rls", async (tenant) => {
        const [account] = await tenant.unsafe<{ id: string }>("select id from public.account");
        return account?.id;
      }),
    ]);
    expect(accountA).toBe(fixture.accountA);
    expect(accountB).toBe(fixture.accountB);
    await expectCleanBorrowedConnection();
  });
});
