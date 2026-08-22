import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbConnection, type DbConnection } from "../../packages/db/src/index";

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

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for PostgreSQL isolation tests");
  const database = new URL(value).pathname.slice(1);
  if (!database.endsWith("_test")) throw new Error(`Refusing non-test database: ${database}`);
  return value;
}

describeDb("PostgreSQL default-deny tenant isolation", () => {
  let db!: DbConnection;
  beforeAll(() => {
    db = createDbConnection(databaseUrlForTest());
  });
  afterAll(async () => db?.end());

  it("returns no tenant rows when context is absent, empty, or malformed", async () => {
    await db
      .begin(async (tx) => {
        await tx.unsafe("set local role api_rls");
        for (const setting of [null, "", "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
          if (setting === null) await tx.unsafe("reset app.tenant");
          else await tx`select set_config('app.tenant', ${setting}, true)`;
          for (const table of TENANT_TABLES) {
            await tx.unsafe("SAVEPOINT tenant_probe");
            let rows: unknown[] = [];
            try {
              rows = await tx.unsafe(`select * from public."${table}"`);
            } catch {
              await tx.unsafe("ROLLBACK TO SAVEPOINT tenant_probe");
            }
            await tx.unsafe("RELEASE SAVEPOINT tenant_probe");
            expect(rows, `${table} with tenant ${setting ?? "absent"}`).toEqual([]);

            const ownershipColumn = table === "account" ? "id" : "account_id";
            for (const operation of [
              `insert into public."${table}" (${ownershipColumn}) values ('00000000-0000-0000-0000-000000000000')`,
              `update public."${table}" set ${ownershipColumn} = '00000000-0000-0000-0000-000000000000' where false`,
              `delete from public."${table}" where false`,
            ]) {
              await tx.unsafe("SAVEPOINT tenant_dml_probe");
              try {
                const result = await tx.unsafe(operation);
                expect(result.count ?? 0, `${table} without tenant`).toBe(0);
              } catch {
                // Permission, policy, or constraint denial is the fail-closed result.
                await tx.unsafe("ROLLBACK TO SAVEPOINT tenant_dml_probe");
              }
              await tx.unsafe("RELEASE SAVEPOINT tenant_dml_probe");
            }
          }
        }
        throw new Error("rollback fixture");
      })
      .catch((error) => {
        expect(error.message).toBe("rollback fixture");
      });
  });

  it("isolates account A from account B for reads, writes, and audit mutation", async () => {
    await db
      .begin(async (tx) => {
        await tx.unsafe("set local role auth_bootstrap");
        const [a] = await tx`
        select * from public.auth_complete_google_login(
          'subject-a', 'a@example.test'::citext, 'hash-a', now() + interval '1 hour', '127.0.0.1'::inet, 'test'
        )
      `;
        const [b] = await tx`
        select * from public.auth_complete_google_login(
          'subject-b', 'b@example.test'::citext, 'hash-b', now() + interval '1 hour', '127.0.0.1'::inet, 'test'
        )
      `;
        expect(a?.account_id).toBeTruthy();
        expect(b?.account_id).toBeTruthy();
        if (!a || !b) throw new Error("auth fixture missing");
        await tx.unsafe("set local role api_rls");
        await tx`select set_config('app.tenant', ${a.account_id}, true)`;

        const own = await tx`select id from public.account`;
        expect(own).toHaveLength(1);
        const other = await tx`select id from public.account where id = ${b.account_id}`;
        expect(other).toEqual([]);

        await tx.unsafe("SAVEPOINT cross_insert");
        const crossInsert = await tx`
        insert into public.account (id, status, settings_ia_enabled)
        values (${b.account_id}, 'active', true)
        on conflict do nothing
      `.catch(async () => {
          await tx.unsafe("ROLLBACK TO SAVEPOINT cross_insert");
          return null;
        });
        await tx.unsafe("RELEASE SAVEPOINT cross_insert");
        expect(crossInsert).toBeNull();
        const crossUpdate = await tx`
        update public.account set status = 'revoked' where id = ${b.account_id}
      `;
        expect(crossUpdate.count).toBe(0);
        await tx.unsafe("SAVEPOINT cross_delete");
        await expect(tx`delete from public.account where id = ${b.account_id}`).rejects.toThrow();
        await tx.unsafe("ROLLBACK TO SAVEPOINT cross_delete");
        await tx.unsafe("RELEASE SAVEPOINT cross_delete");

        const [audit] = await tx`
        insert into public.audit_event (account_id, actor, action, payload_json)
        values (${a.account_id}, 'test', 'request', '{}'::jsonb)
        returning id
      `;
        expect(audit?.id).toBeTruthy();
        if (!audit) throw new Error("audit fixture missing");
        await tx.unsafe("SAVEPOINT audit_update");
        await expect(
          tx`update public.audit_event set actor = 'tampered' where id = ${audit.id}`,
        ).rejects.toThrow();
        await tx.unsafe("ROLLBACK TO SAVEPOINT audit_update");
        await tx.unsafe("RELEASE SAVEPOINT audit_update");
        await tx.unsafe("SAVEPOINT audit_delete");
        await expect(tx`delete from public.audit_event where id = ${audit.id}`).rejects.toThrow();
        await tx.unsafe("ROLLBACK TO SAVEPOINT audit_delete");
        await tx.unsafe("RELEASE SAVEPOINT audit_delete");
        throw new Error("rollback fixture");
      })
      .catch((error) => {
        expect(error.message).toBe("rollback fixture");
      });
  });

  it("keeps playbook read-only and reporting read-only", async () => {
    await db
      .begin(async (tx) => {
        await tx.unsafe("reset role");
        await tx`
        insert into public.playbook (key, playbook_version, target_category, contract_json, active)
        values ('test', '1.0.0', 'surface', '{}'::jsonb, true)
      `;
        await tx.unsafe("set local role api_rls");
        await tx.unsafe("SAVEPOINT playbook_insert");
        await expect(
          tx`insert into public.playbook (key, playbook_version, target_category, contract_json, active)
           values ('forbidden', '1.0.0', 'surface', '{}'::jsonb, true)`,
        ).rejects.toThrow();
        await tx.unsafe("ROLLBACK TO SAVEPOINT playbook_insert");
        await tx.unsafe("RELEASE SAVEPOINT playbook_insert");
        await tx.unsafe("set local role reporting_rls");
        await tx.unsafe("SAVEPOINT reporting_update");
        await expect(
          tx`update public.account set status = 'revoked' where false`,
        ).rejects.toThrow();
        await tx.unsafe("ROLLBACK TO SAVEPOINT reporting_update");
        await tx.unsafe("RELEASE SAVEPOINT reporting_update");
        await tx.unsafe("SAVEPOINT reporting_delete");
        await expect(tx`delete from public.account where false`).rejects.toThrow();
        await tx.unsafe("ROLLBACK TO SAVEPOINT reporting_delete");
        await tx.unsafe("RELEASE SAVEPOINT reporting_delete");
        throw new Error("rollback fixture");
      })
      .catch((error) => {
        expect(error.message).toBe("rollback fixture");
      });
  });
});
