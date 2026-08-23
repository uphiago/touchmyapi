import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as publicDb from "../src/index";
import {
  createTenantDatabase,
  withTenant,
  type RuntimeRole,
  type TenantContext,
  type TenantDatabase,
} from "../src/index";
import {
  createRawDbConnection,
  getRawTenantDatabase,
  type RawDbConnection,
} from "../src/connection-internal";

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
};

async function createFixture(db: RawDbConnection): Promise<Fixture> {
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
    return {
      accountA: accountA.account_id,
      accountB: accountB.account_id,
      sessionA: accountA.session_id,
      sessionB: accountB.session_id,
      userA: accountA.user_id,
      userB: accountB.user_id,
    };
  });
}

describe.skipIf(!RUN_DB_TESTS)("withTenant closed capability boundary", () => {
  let adminDb!: RawDbConnection;
  let db!: TenantDatabase;
  let adminTenantDb!: TenantDatabase;
  let fixture!: Fixture;
  let connectorRole = "";
  let connectorPassword = "";

  async function expectCleanBorrowedConnection(): Promise<void> {
    const connectorDb = getRawTenantDatabase(db);
    const [state] = await connectorDb`
      select current_user as role, current_setting('app.tenant', true) as tenant
    `;
    expect(state?.role).toBe(connectorRole);
    expect(state?.tenant ?? "").toBe("");
  }

  beforeAll(async () => {
    const databaseUrl = databaseUrlForTest();
    adminDb = createRawDbConnection(databaseUrl);
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
    db = createTenantDatabase(connectorUrl.toString());
    adminTenantDb = createTenantDatabase(databaseUrl);
  });

  afterAll(async () => {
    try {
      if (db) await getRawTenantDatabase(db).end();
      if (adminTenantDb) await getRawTenantDatabase(adminTenantDb).end();
    } finally {
      try {
        if (fixture) {
          await adminDb.begin(async (tx) => {
            await tx.unsafe("delete from public.audit_event where account_id in ($1, $2)", [
              fixture.accountA,
              fixture.accountB,
            ]);
            await tx.unsafe("delete from public.session where account_id in ($1, $2)", [
              fixture.accountA,
              fixture.accountB,
            ]);
            await tx.unsafe("delete from public.account_membership where account_id in ($1, $2)", [
              fixture.accountA,
              fixture.accountB,
            ]);
            await tx.unsafe('delete from public."user" where account_id in ($1, $2)', [
              fixture.accountA,
              fixture.accountB,
            ]);
            await tx.unsafe("delete from public.account where id in ($1, $2)", [
              fixture.accountA,
              fixture.accountB,
            ]);
          });
        }
      } finally {
        try {
          if (connectorRole) await adminDb.unsafe(`drop role ${quoteIdentifier(connectorRole)}`);
        } finally {
          await adminDb?.end();
        }
      }
    }
  });

  it("exposes only closed account capability and returns the context account", async () => {
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      expect(Object.isFrozen(tenant)).toBe(true);
      expect(Object.isFrozen(tenant.account)).toBe(true);
      expect("unsafe" in tenant).toBe(false);
      expect("query" in tenant).toBe(false);
      expect("sql" in tenant).toBe(false);
      expect("connection" in tenant).toBe(false);
      expect("executor" in tenant).toBe(false);
      expect(Object.keys(tenant).sort()).toEqual(["account", "role"]);
      expect(Object.keys(tenant.account).sort()).toEqual(["readCurrent", "setIaEnabled"]);
      expect(await tenant.account.readCurrent()).toMatchObject({ id: fixture.accountA });
    });
    await expectCleanBorrowedConnection();
  });

  it("keeps RLS account reads isolated for API, worker, and read-only reporting roles", async () => {
    for (const role of ["api_rls", "worker_rls", "reporting_rls"] as const) {
      await withTenant(db, fixture.accountA, role, async (tenant) => {
        expect((await tenant.account.readCurrent())?.id).toBe(fixture.accountA);
      });
    }
    await withTenant(db, fixture.accountB, "api_rls", async (tenant) => {
      expect((await tenant.account.readCurrent())?.id).toBe(fixture.accountB);
    });
    await expectCleanBorrowedConnection();
  });

  it("exposes setIaEnabled only to api_rls", async () => {
    await adminDb.unsafe("revoke update on public.account from worker_rls");
    try {
      await withTenant(db, fixture.accountA, "worker_rls", async (tenant) => {
        await adminDb.unsafe("grant update on public.account to worker_rls");
        expect("setIaEnabled" in tenant.account).toBe(false);
        expect(Object.keys(tenant.account)).toEqual(["readCurrent"]);
        expect((await tenant.account.readCurrent())?.id).toBe(fixture.accountA);
      });
    } finally {
      await adminDb.unsafe("revoke update on public.account from worker_rls");
    }
    await withTenant(db, fixture.accountA, "reporting_rls", async (tenant) => {
      expect("setIaEnabled" in tenant.account).toBe(false);
      expect(Object.keys(tenant.account)).toEqual(["readCurrent"]);
    });
  });

  it("expires a captured context after success, rollback, and callback failure", async () => {
    let successfulCapture!: TenantContext;
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      successfulCapture = tenant;
      await tenant.account.readCurrent();
    });
    await expect(successfulCapture.account.readCurrent()).rejects.toThrow(
      /no longer active|expired/i,
    );

    let failedCapture!: TenantContext;
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        failedCapture = tenant;
        await tenant.account.readCurrent();
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");
    await expect(failedCapture.account.readCurrent()).rejects.toThrow(/no longer active|expired/i);
    await expectCleanBorrowedConnection();
  });

  it("rejects invalid account, role, privileged principal, and same-connection nesting", async () => {
    await expect(
      withTenant(db, "not-a-uuid", "api_rls", async () => "unreachable"),
    ).rejects.toThrow(/accountId.*UUID/i);
    await expect(
      withTenant(db, fixture.accountA, "invalid_role" as RuntimeRole, async () => "unreachable"),
    ).rejects.toThrow(/role/i);
    await expect(
      withTenant(adminTenantDb, fixture.accountA, "api_rls", async () => "unreachable"),
    ).rejects.toThrow(/privileged|owner|connector/i);
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async () =>
        withTenant(db, fixture.accountA, "api_rls", async () => "unreachable"),
      ),
    ).rejects.toThrow(/nested/i);
    await expectCleanBorrowedConnection();
  });

  it("rejects unsafe connector function grants and runtime table privileges", async () => {
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

    await adminDb.unsafe(`grant select on public.account to ${quoteIdentifier(connectorRole)}`);
    try {
      await expect(
        withTenant(db, fixture.accountA, "api_rls", async () => "unreachable"),
      ).rejects.toThrow(/direct tenant table access|direct public table access|connector/i);
    } finally {
      await adminDb.unsafe(
        `revoke select on public.account from ${quoteIdentifier(connectorRole)}`,
      );
    }

    await adminDb.unsafe("grant trigger on public.account to api_rls");
    try {
      await expect(
        withTenant(db, fixture.accountA, "api_rls", async () => "unreachable"),
      ).rejects.toThrow(/unexpected.*privilege|switched principal/i);
    } finally {
      await adminDb.unsafe("revoke trigger on public.account from api_rls");
    }
    await expectCleanBorrowedConnection();
  });

  it("rejects a runtime membership whose SET option is false", async () => {
    const restrictedRole = `tma_t016_set_false_${randomUUID().replaceAll("-", "")}`;
    const restrictedPassword = randomUUID().replaceAll("-", "");
    const roleIdentifier = quoteIdentifier(restrictedRole);
    let restrictedDb: TenantDatabase | undefined;
    try {
      await adminDb.unsafe(
        `create role ${roleIdentifier} login noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password ${sqlStringLiteral(restrictedPassword)}`,
      );
      await adminDb.unsafe(`grant api_rls to ${roleIdentifier} with set false`);
      const restrictedUrl = new URL(databaseUrlForTest());
      restrictedUrl.username = restrictedRole;
      restrictedUrl.password = restrictedPassword;
      restrictedDb = createTenantDatabase(restrictedUrl.toString());
      await expect(
        withTenant(restrictedDb, fixture.accountA, "api_rls", async () => "unreachable"),
      ).rejects.toThrow(/SET FALSE|set_option|membership/i);
    } finally {
      if (restrictedDb) await getRawTenantDatabase(restrictedDb).end();
      await adminDb.unsafe(`drop role ${roleIdentifier}`);
    }
  });

  it("does not widen the closed capability after a post-preflight live grant", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const probeTable = `tma_t016_probe_${suffix}`;
    const identifier = quoteIdentifier(probeTable);
    let created = false;
    try {
      await adminDb.unsafe(`create table public.${identifier} (secret text not null)`);
      created = true;
      await adminDb.unsafe(
        `insert into public.${identifier} (secret) values ('should-not-be-readable')`,
      );
      await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        await adminDb.unsafe(`grant select on public.${identifier} to api_rls`);
        expect("unsafe" in tenant).toBe(false);
        expect("query" in tenant).toBe(false);
        expect("sql" in tenant).toBe(false);
        expect("raw" in tenant).toBe(false);
        expect(await tenant.account.readCurrent()).toMatchObject({ id: fixture.accountA });
      });
    } finally {
      if (created) {
        await adminDb.unsafe(`revoke select on public.${identifier} from api_rls`);
        await adminDb.unsafe(`drop table public.${identifier}`);
      }
    }
    await expectCleanBorrowedConnection();
  });

  it("clears local tenant state and releases the backend after callback failure", async () => {
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        expect(await tenant.account.readCurrent()).toMatchObject({ id: fixture.accountA });
        throw new Error("rollback capability probe");
      }),
    ).rejects.toThrow("rollback capability probe");
    await expectCleanBorrowedConnection();
    await withTenant(db, fixture.accountB, "reporting_rls", async (tenant) => {
      expect(await tenant.account.readCurrent()).toMatchObject({ id: fixture.accountB });
    });
    await expectCleanBorrowedConnection();
  });

  it("rolls back account.setIaEnabled and expires the mutation capability", async () => {
    const [before] = await adminDb`
      select settings_ia_enabled from public.account where id = ${fixture.accountA}
    `;
    let captured!: TenantContext<"api_rls">;
    await expect(
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
        captured = tenant;
        await tenant.account.setIaEnabled(false);
        expect((await tenant.account.readCurrent())?.settings_ia_enabled).toBe(false);
        throw new Error("rollback IA mutation");
      }),
    ).rejects.toThrow("rollback IA mutation");
    await expect(captured.account.setIaEnabled(true)).rejects.toThrow(/no longer active|expired/i);
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      expect((await tenant.account.readCurrent())?.settings_ia_enabled).toBe(
        before?.settings_ia_enabled,
      );
    });
    await withTenant(db, fixture.accountA, "reporting_rls", async (tenant) => {
      expect("setIaEnabled" in tenant.account).toBe(false);
    });
  });

  it("rejects setIaEnabled for revoked and deleted accounts", async () => {
    const [before] = await adminDb`
      select status, settings_ia_enabled, deleted_at
      from public.account where id = ${fixture.accountA}
    `;
    try {
      await adminDb`update public.account set status = 'revoked' where id = ${fixture.accountA}`;
      await expect(
        withTenant(db, fixture.accountA, "api_rls", async (tenant) =>
          tenant.account.setIaEnabled(false),
        ),
      ).rejects.toThrow("active tenant account required");
      await adminDb`update public.account set status = 'active', deleted_at = now() where id = ${fixture.accountA}`;
      await expect(
        withTenant(db, fixture.accountA, "api_rls", async (tenant) =>
          tenant.account.setIaEnabled(false),
        ),
      ).rejects.toThrow("active tenant account required");
    } finally {
      await adminDb`
        update public.account
        set status = ${before?.status ?? "active"},
            settings_ia_enabled = ${before?.settings_ia_enabled ?? true},
            deleted_at = ${before?.deleted_at ?? null}
        where id = ${fixture.accountA}
      `;
    }
  });

  it("keeps parallel tenant transactions isolated on one opaque database", async () => {
    const [accountA, accountB] = await Promise.all([
      withTenant(db, fixture.accountA, "api_rls", async (tenant) => tenant.account.readCurrent()),
      withTenant(db, fixture.accountB, "worker_rls", async (tenant) =>
        tenant.account.readCurrent(),
      ),
    ]);
    expect(accountA?.id).toBe(fixture.accountA);
    expect(accountB?.id).toBe(fixture.accountB);
    await expectCleanBorrowedConnection();
  });

  it("returns callback values without exposing a transaction object", async () => {
    const result = await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      await tenant.account.readCurrent();
      return "callback-result";
    });
    expect(result).toBe("callback-result");
    await expectCleanBorrowedConnection();
  });

  it("keeps the selected role readonly and closed at runtime", async () => {
    await withTenant(db, fixture.accountA, "reporting_rls", async (tenant) => {
      expect(tenant.role).toBe("reporting_rls");
      expect(Object.getOwnPropertyNames(tenant)).toEqual(["role", "account"]);
      expect(Object.getOwnPropertyNames(tenant.account)).toEqual(["readCurrent"]);
      expect(Object.getOwnPropertyDescriptor(tenant, "role")?.writable).toBe(false);
    });
  });

  it("normalizes an uppercase canonical UUID without changing tenant selection", async () => {
    const uppercase = fixture.accountA.toUpperCase();
    await withTenant(db, uppercase, "worker_rls", async (tenant) => {
      expect((await tenant.account.readCurrent())?.id).toBe(fixture.accountA);
    });
  });

  it("rejects a non-function callback before reserving a backend", async () => {
    await expect(withTenant(db, fixture.accountA, "api_rls", null as never)).rejects.toThrow(
      /callback/i,
    );
    await expectCleanBorrowedConnection();
  });

  it("binds the canonical context account even when an operation receives ignored arguments", async () => {
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      const readCurrent = tenant.account.readCurrent as unknown as (
        accountId?: string,
      ) => Promise<{ id: string } | null>;
      expect((await readCurrent(fixture.accountB))?.id).toBe(fixture.accountA);
    });
  });

  it("does not let an expired capability become active through repeated calls", async () => {
    let captured!: TenantContext;
    await withTenant(db, fixture.accountA, "worker_rls", async (tenant) => {
      captured = tenant;
      expect((await tenant.account.readCurrent())?.id).toBe(fixture.accountA);
    });
    await expect(captured.account.readCurrent()).rejects.toThrow(/no longer active|expired/i);
    await expect(captured.account.readCurrent()).rejects.toThrow(/no longer active|expired/i);
  });

  it("does not publish tenant-internal helpers through the public module", async () => {
    expect("activateTenantContext" in publicDb).toBe(false);
    expect("expireTenantContext" in publicDb).toBe(false);
    expect("getActiveTenantExecutor" in publicDb).toBe(false);
    expect("tenant-internal" in publicDb).toBe(false);
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, string> };
    expect(manifest.exports).toEqual({ ".": "./src/index.ts" });
    expect(manifest.exports?.["./src/connection-internal"]).toBeUndefined();
    expect(manifest.exports?.["./src/tenant-internal"]).toBeUndefined();
  });

  it("returns only one account row despite another tenant being present", async () => {
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      const first = await tenant.account.readCurrent();
      const second = await tenant.account.readCurrent();
      expect(first?.id).toBe(fixture.accountA);
      expect(second?.id).toBe(fixture.accountA);
    });
    await withTenant(db, fixture.accountB, "api_rls", async (tenant) => {
      expect((await tenant.account.readCurrent())?.id).toBe(fixture.accountB);
    });
  });

  it("keeps reporting capability read-only by exposing no mutation methods", async () => {
    await withTenant(db, fixture.accountA, "reporting_rls", async (tenant) => {
      expect(Object.keys(tenant.account)).toEqual(["readCurrent"]);
      expect("insert" in tenant.account).toBe(false);
      expect("update" in tenant.account).toBe(false);
      expect("delete" in tenant.account).toBe(false);
    });
  });

  it("releases the reserved backend after invalid preflight state", async () => {
    await expect(
      withTenant(db, fixture.accountA, "invalid_role" as RuntimeRole, async () => "unreachable"),
    ).rejects.toThrow(/role/i);
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      expect((await tenant.account.readCurrent())?.id).toBe(fixture.accountA);
    });
    await expectCleanBorrowedConnection();
  });

  it("keeps post-grant reads limited to the account capability contract", async () => {
    await withTenant(db, fixture.accountB, "worker_rls", async (tenant) => {
      expect(Object.keys(tenant).sort()).toEqual(["account", "role"]);
      expect((await tenant.account.readCurrent())?.id).toBe(fixture.accountB);
    });
    await expectCleanBorrowedConnection();
  });

  it("returns no row for a canonical account that is not present", async () => {
    const absentAccount = randomUUID();
    await withTenant(db, absentAccount, "reporting_rls", async (tenant) => {
      expect(await tenant.account.readCurrent()).toBeNull();
    });
  });

  it("keeps the capability object immutable during the callback", async () => {
    await withTenant(db, fixture.accountA, "api_rls", async (tenant) => {
      expect(Object.isFrozen(tenant.account)).toBe(true);
      expect(() => Object.assign(tenant.account, { unsafe: () => [] })).toThrow();
      expect((await tenant.account.readCurrent())?.id).toBe(fixture.accountA);
    });
  });
});
