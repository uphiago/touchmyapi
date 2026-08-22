import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
  let db!: DbConnection;
  let fixture!: Fixture;

  beforeAll(async () => {
    db = createDbConnection(databaseUrlForTest());
    fixture = await createFixture(db);
  });

  afterAll(async () => {
    if (fixture) {
      await db.begin(async (tx) => {
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
    await db?.end();
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
      await db`select status from public.assessment where id = ${fixture.assessmentA}`;
    expect(assessment?.status).toBe("draft");
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
    ).rejects.toThrow(/does not exist/i);

    const [assessment] =
      await db`select status from public.assessment where id = ${fixture.assessmentA}`;
    expect(assessment?.status).toBe("draft");
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

  it("keeps nested scopes independent and expires captured TenantConnections", async () => {
    let captured!: TenantConnection;
    await withTenant(db, fixture.accountA, "api_rls", async (outer) => {
      captured = outer;
      const [outerAccount] = await outer.unsafe<{ id: string }>("select id from public.account");
      expect(outerAccount?.id).toBe(fixture.accountA);
      await withTenant(db, fixture.accountB, "reporting_rls", async (inner) => {
        const [innerAccount] = await inner.unsafe<{ id: string }>("select id from public.account");
        expect(innerAccount?.id).toBe(fixture.accountB);
      });
      const [outerAgain] = await outer.unsafe<{ id: string }>("select id from public.account");
      expect(outerAgain?.id).toBe(fixture.accountA);
    });
    await expect(captured.unsafe("select 1")).rejects.toThrow(/no longer active/i);

    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        await tenant.unsafe("select * from public.table_that_does_not_exist");
      }),
    ).rejects.toThrow(/does not exist/i);
    const [state] =
      await db`select current_user as role, current_setting('app.tenant', true) as tenant`;
    expect(state?.role).not.toMatch(/^(api|worker|reporting)_rls$/);
    expect(state?.tenant ?? "").toBe("");
  });

  it("leaves no tenant or runtime role on a borrowed connection and keeps reporting read-only", async () => {
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      await tenant.unsafe("select 1");
    });
    const [state] =
      await db`select current_user as role, current_setting('app.tenant', true) as tenant`;
    expect(state?.role).not.toMatch(/^(api|worker|reporting)_rls$/);
    expect(state?.tenant ?? "").toBe("");

    await expect(
      withTenant(db, fixture.accountA, "reporting_rls", async (tenant) => {
        await tenant.unsafe("update public.finding set title = 'forbidden' where id = $1", [
          fixture.findingA,
        ]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
