import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";
import { ensureQueueState } from "../src/queue-bootstrap";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for queue schema tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Queue schema tests require a loopback *_test database");
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("PostgreSQL queue schema and bootstrap", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForTest());
  });

  afterAll(async () => db?.end());

  it("creates queue state, outbox operational fields, and active-target protection", async () => {
    const tables = await db.unsafe(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('queue_global_state', 'queue_tenant_state', 'outbox_event') order by table_name",
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      "outbox_event",
      "queue_global_state",
      "queue_tenant_state",
    ]);
    const [global] = await db.unsafe(
      "select id, running_count, concurrency_limit from public.queue_global_state",
    );
    expect(global).toEqual({ id: "global", running_count: 0, concurrency_limit: 8 });
    const columns = await db.unsafe(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'outbox_event' order by ordinal_position",
    );
    expect(columns.map((row) => row.column_name)).toEqual([
      "id",
      "account_id",
      "event_key",
      "aggregate_type",
      "aggregate_id",
      "schema_version",
      "payload_json",
      "status",
      "attempts",
      "max_attempts",
      "available_at",
      "lease_owner",
      "lease_expires_at",
      "fencing_token",
      "heartbeat_at",
      "last_error",
      "failed_at",
      "processed_at",
      "created_at",
    ]);
    const [index] = await db.unsafe(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = 'job_active_target_unique'",
    );
    expect(index?.indexdef).toMatch(/status.*queued.*stale_recovered.*running/is);
  });

  it("keeps queue tables forced-RLS and connectors separated from table access", async () => {
    const rls = await db.unsafe(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('queue_global_state', 'queue_tenant_state', 'outbox_event') order by relname",
    );
    expect(rls).toEqual([
      { relname: "outbox_event", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "queue_global_state", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "queue_tenant_state", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const [control] = await db.unsafe(
      "select rolcanlogin, rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = 'queue_control'",
    );
    expect(control).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolinherit: false,
    });
    const grants = await db.unsafe(
      "select table_name, privilege_type from information_schema.role_table_grants where grantee = 'queue_connector' and table_name in ('queue_global_state', 'queue_tenant_state', 'outbox_event')",
    );
    expect(grants).toEqual([]);
    const functions = await db.unsafe(
      "select p.proname, oidvectortypes(p.proargtypes) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_private' and p.proname in ('outbox_claim', 'outbox_heartbeat', 'outbox_ack', 'outbox_fail', 'outbox_reap') order by p.proname",
    );
    expect(functions).toEqual([
      { proname: "outbox_ack", args: "uuid, uuid, text, bigint, timestamp with time zone" },
      { proname: "outbox_claim", args: "text, integer, timestamp with time zone" },
      { proname: "outbox_fail", args: "uuid, uuid, text, bigint, text, timestamp with time zone" },
      { proname: "outbox_heartbeat", args: "uuid, uuid, text, bigint, timestamp with time zone" },
      { proname: "outbox_reap", args: "integer, timestamp with time zone" },
    ]);
  });

  it("upserts global and tenant state without selecting account membership", async () => {
    const [account] = await db.unsafe("insert into public.account default values returning id");
    if (!account) throw new Error("queue account fixture missing");
    try {
      const [bootstrapped] = await db.unsafe(
        "select account_id, running_count, concurrency_limit from public.queue_tenant_state where account_id = $1::uuid",
        [account.id],
      );
      expect(bootstrapped).toEqual({
        account_id: account.id,
        running_count: 0,
        concurrency_limit: 2,
      });
      await ensureQueueState(db, account.id, {
        globalConcurrencyLimit: 9,
        tenantConcurrencyLimit: 3,
      });
      const [global] = await db.unsafe(
        "select running_count, concurrency_limit from public.queue_global_state",
      );
      const [tenant] = await db.unsafe(
        "select account_id, running_count, concurrency_limit from public.queue_tenant_state where account_id = $1::uuid",
        [account.id],
      );
      expect(global).toEqual({ running_count: 0, concurrency_limit: 9 });
      expect(tenant).toEqual({ account_id: account.id, running_count: 0, concurrency_limit: 3 });
      await ensureQueueState(db, account.id);
      const [updated] = await db.unsafe(
        "select concurrency_limit from public.queue_tenant_state where account_id = $1::uuid",
        [account.id],
      );
      expect(updated).toEqual({ concurrency_limit: 2 });
    } finally {
      await db.unsafe("delete from public.queue_tenant_state where account_id = $1::uuid", [
        account.id,
      ]);
      await db.unsafe("delete from public.account where id = $1::uuid", [account.id]);
    }
  });
});
