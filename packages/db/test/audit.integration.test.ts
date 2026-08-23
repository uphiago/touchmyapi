import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  appendSystemAuditEvent,
  createSystemAuditDatabase,
  createTenantDatabase,
  withSystemAudit,
  withTenant,
  type SystemAuditContext,
  type SystemAuditDatabase,
  type TenantDatabase,
  type TenantContext,
} from "../src";
import {
  createRawDbConnection,
  getRawSystemAuditDatabase,
  getRawTenantDatabase,
  type RawDbConnection,
} from "../src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for PostgreSQL audit tests");
  const parsed = new URL(value);
  if (parsed.hostname !== "127.0.0.1" || !parsed.pathname.slice(1).endsWith("_test")) {
    throw new Error("Refusing non-loopback or non-test audit database");
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
  accountId: string;
  role: string;
  connector: TenantDatabase;
  system: SystemAuditDatabase;
};

async function createFixture(owner: RawDbConnection): Promise<Fixture> {
  const run = randomUUID();
  const role = `tma_t017_${run.replaceAll("-", "")}`;
  const password = randomUUID().replaceAll("-", "");
  await owner.unsafe(
    `create role ${quoteIdentifier(role)} login noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password ${sqlStringLiteral(password)}`,
  );
  await owner.unsafe(`grant api_rls to ${quoteIdentifier(role)}`);
  const systemPassword = randomUUID().replaceAll("-", "");
  await owner.unsafe(
    `alter role audit_system_connector password ${sqlStringLiteral(systemPassword)}`,
  );
  const [account] = await owner.begin(async (tx) => {
    await tx.unsafe("set local role auth_bootstrap");
    return tx`select * from public.auth_complete_google_login(
      ${`t017-${run}`}, ${`t017-${run}@example.test`}::citext,
      ${run.replaceAll("-", "") + "a".repeat(32)}, now() + interval '1 hour', null, null
    )`;
  });
  if (!account) throw new Error("audit fixture account missing");
  await owner.unsafe("delete from public.audit_event where account_id = $1::uuid", [
    account.account_id,
  ]);
  const connectorUrl = new URL(databaseUrlForTest());
  connectorUrl.username = role;
  connectorUrl.password = password;
  const systemUrl = new URL(databaseUrlForTest());
  systemUrl.username = "audit_system_connector";
  systemUrl.password = systemPassword;
  return {
    accountId: account.account_id,
    role,
    connector: createTenantDatabase(connectorUrl.toString()),
    system: createSystemAuditDatabase(systemUrl.toString()),
  };
}

describeDb("closed audit append capabilities", () => {
  let owner!: RawDbConnection;
  let fixture!: Fixture;

  beforeAll(async () => {
    owner = createRawDbConnection(databaseUrlForTest());
    fixture = await createFixture(owner);
  });

  afterAll(async () => {
    await getRawTenantDatabase(fixture.connector)?.end();
    if (fixture?.system) await getRawSystemAuditDatabase(fixture.system)?.end();
    if (fixture) {
      await owner.begin(async (tx) => {
        await tx.unsafe(
          "delete from public.audit_event where account_id is null and actor in ('system:a', 'system:b')",
        );
        await tx.unsafe("delete from public.audit_event where account_id = $1::uuid", [
          fixture.accountId,
        ]);
        await tx.unsafe("delete from public.session where account_id = $1::uuid", [
          fixture.accountId,
        ]);
        await tx.unsafe('delete from public."user" where account_id = $1::uuid', [
          fixture.accountId,
        ]);
        await tx.unsafe("delete from public.account where id = $1::uuid", [fixture.accountId]);
      });
    }
    await owner?.end();
    if (fixture?.role) {
      const cleanup = createRawDbConnection(databaseUrlForTest());
      await cleanup.unsafe(`drop role if exists ${quoteIdentifier(fixture.role)}`);
      await cleanup.end();
    }
  });

  it("redacts nested sensitive values and never mutates input", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature";
    const pem = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";
    const payload = {
      password: "do-not-store",
      nested: [{ authorization: "Bearer do-not-store" }, { note: jwt }],
      certificate: pem,
      safe: { count: 1 },
    };
    const original = structuredClone(payload);
    const event = await withTenant(fixture.connector, fixture.accountId, "api_rls", (context) =>
      appendAuditEvent(context, { actor: "user:test", action: "policy", payload }),
    );
    expect(event.accountId).toBe(fixture.accountId);
    expect(event.prevEventId).toBeNull();
    expect(payload).toEqual(original);
    const [row] = await owner`select payload_json from public.audit_event where id = ${event.id}`;
    const stored = JSON.stringify(row?.payload_json);
    expect(stored).toContain("[REDACTED]");
    expect(stored).not.toContain("do-not-store");
    expect(stored).not.toContain(jwt);
    expect(stored).not.toContain(pem);
    await owner.unsafe("delete from public.audit_event where id = $1::uuid", [event.id]);
  });

  it("serializes concurrent tenant appends into one linked chain", async () => {
    const [first, second] = await Promise.all([
      withTenant(fixture.connector, fixture.accountId, "api_rls", (context) =>
        appendAuditEvent(context, { actor: "user:a", action: "request", payload: { index: 1 } }),
      ),
      withTenant(fixture.connector, fixture.accountId, "api_rls", (context) =>
        appendAuditEvent(context, { actor: "user:b", action: "request", payload: { index: 2 } }),
      ),
    ]);
    const rows = await owner`
      select id, prev_event_id from public.audit_event
      where account_id = ${fixture.accountId} and actor in ('user:a', 'user:b') order by created_at, id
    `;
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([first.id, second.id]));
    expect(rows.filter((row) => row.prev_event_id === null)).toHaveLength(1);
    expect(rows.filter((row) => row.prev_event_id !== null)).toHaveLength(1);
  });

  it("expires captured tenant and system contexts", async () => {
    let tenantContext!: TenantContext;
    await withTenant(fixture.connector, fixture.accountId, "api_rls", async (context) => {
      tenantContext = context;
    });
    await expect(
      appendAuditEvent(tenantContext, {
        actor: "user:test",
        action: "request",
        payload: {},
      }),
    ).rejects.toThrow(/no longer active|expired/i);

    let systemContext!: SystemAuditContext;
    await withSystemAudit(fixture.system, async (context) => {
      systemContext = context;
    });
    await expect(
      appendSystemAuditEvent(systemContext, {
        actor: "system:test",
        action: "request",
        payload: {},
      }),
    ).rejects.toThrow(/no longer active|expired/i);
  });

  it("serializes accountless system appends on the singleton lock", async () => {
    const [first, second] = await Promise.all([
      withSystemAudit(fixture.system, (context) =>
        appendSystemAuditEvent(context, {
          actor: "system:a",
          action: "request",
          payload: { index: 1 },
        }),
      ),
      withSystemAudit(fixture.system, (context) =>
        appendSystemAuditEvent(context, {
          actor: "system:b",
          action: "request",
          payload: { index: 2 },
        }),
      ),
    ]);
    expect(first.accountId).toBeNull();
    expect(second.accountId).toBeNull();
    const rows = await owner`
      select id, prev_event_id from public.audit_event
      where account_id is null and actor in ('system:a', 'system:b')
      order by created_at, id
    `;
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([first.id, second.id]));
    expect(rows.filter((row) => row.prev_event_id === null)).toHaveLength(1);
    expect(rows.filter((row) => row.prev_event_id !== null)).toHaveLength(1);
  });

  it("rolls back a tenant mutation and its audit append together", async () => {
    const [before] = await owner`
      select settings_ia_enabled from public.account where id = ${fixture.accountId}
    `;
    if (!before) throw new Error("audit rollback fixture account missing");
    await expect(
      withTenant(fixture.connector, fixture.accountId, "api_rls", async (context) => {
        await context.account.setIaEnabled(!before.settings_ia_enabled);
        await appendAuditEvent(context, {
          actor: "user:rollback",
          action: "policy",
          payload: { mutation: true },
        });
        throw new Error("audit rollback probe");
      }),
    ).rejects.toThrow("audit rollback probe");
    const [after] = await owner`
      select settings_ia_enabled from public.account where id = ${fixture.accountId}
    `;
    expect(after?.settings_ia_enabled).toBe(before?.settings_ia_enabled);
    const rows = await owner`
      select id from public.audit_event where account_id = ${fixture.accountId} and actor = 'user:rollback'
    `;
    expect(rows).toEqual([]);
  });

  it("rejects tenant audit history updates and deletes through the runtime connector", async () => {
    const connector = getRawTenantDatabase(fixture.connector);
    await expect(
      connector.begin(async (tx) => {
        await tx.unsafe("set local role api_rls");
        await tx.unsafe("select set_config('app.tenant', $1, true)", [fixture.accountId]);
        await tx.unsafe(
          "update public.audit_event set actor = 'tampered' where account_id = $1::uuid",
          [fixture.accountId],
        );
      }),
    ).rejects.toThrow();
    await expect(
      connector.begin(async (tx) => {
        await tx.unsafe("set local role api_rls");
        await tx.unsafe("select set_config('app.tenant', $1, true)", [fixture.accountId]);
        await tx.unsafe("delete from public.audit_event where account_id = $1::uuid", [
          fixture.accountId,
        ]);
      }),
    ).rejects.toThrow();
  });

  it("keeps the system capability accountless and denies business-table access", async () => {
    await expect(
      withSystemAudit(fixture.system, (context) =>
        appendSystemAuditEvent(context, {
          actor: "system:invalid",
          action: "request",
          payload: {},
          assessmentId: randomUUID(),
        }),
      ),
    ).rejects.toThrow("invalid audit input");
    const system = getRawSystemAuditDatabase(fixture.system);
    await expect(
      system.begin(async (tx) => {
        await tx.unsafe("set local role audit_system");
        await tx.unsafe("select id from public.account limit 1");
      }),
    ).rejects.toThrow();
    await expect(
      system.begin(async (tx) => {
        await tx.unsafe("set local role audit_system");
        await tx.unsafe(
          "insert into public.audit_event (account_id, actor, action, payload_json) values ($1::uuid, 'system:invalid', 'request', '{}'::jsonb)",
          [fixture.accountId],
        );
      }),
    ).rejects.toThrow();
  });

  it("rejects dangerous connector grants before switching roles", async () => {
    await owner.unsafe("grant select on public.account to audit_system_connector");
    try {
      await expect(withSystemAudit(fixture.system, async () => "unreachable")).rejects.toThrow(
        /direct public table access|connector/i,
      );
    } finally {
      await owner.unsafe("revoke select on public.account from audit_system_connector");
    }
    await owner.unsafe(
      "grant execute on function public.rls_tenant_matches(uuid) to audit_system_connector",
    );
    try {
      await expect(withSystemAudit(fixture.system, async () => "unreachable")).rejects.toThrow(
        /function access|connector/i,
      );
    } finally {
      await owner.unsafe(
        "revoke execute on function public.rls_tenant_matches(uuid) from audit_system_connector",
      );
    }
  });
});
