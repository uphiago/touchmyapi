import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";
import { reconcileQueueState } from "../src/queue-control";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for queue reconcile tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Queue reconcile tests require a loopback *_test database");
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("queue state reconciliation", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForTest());
  });

  afterAll(async () => db?.end());

  it("recreates missing tenant state from operational rows and repairs counters", async () => {
    const accountId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    try {
      await db.unsafe("insert into public.account (id) values ($1::uuid)", [accountId]);
      await db
        .unsafe(
          "insert into public.job (id, account_id, assessment_id, playbook_version, job_spec_json, status, available_at, priority, normalized_target_key, attempts, max_attempts, fencing_token, dedupe_key) values ($1::uuid, $2::uuid, $2::uuid, '1.0.0', '{}'::jsonb, 'queued', now(), 0, $3, 0, 3, 0, $4)",
          [jobId, accountId, "reconcile.example", "reconcile-" + jobId],
        )
        .catch(async () => {
          await db.unsafe(
            "insert into public.outbox_event (id, account_id, event_key, aggregate_type, schema_version, payload_json, status, attempts, max_attempts, available_at, fencing_token) values ($1::uuid, $2::uuid, $3, 'test', 'test@1', '{}'::jsonb, 'pending', 0, 3, now(), 0)",
            [crypto.randomUUID(), accountId, "reconcile:" + jobId],
          );
        });
      await db.unsafe("delete from public.queue_tenant_state where account_id = $1::uuid", [
        accountId,
      ]);
      await db.unsafe(
        "update public.queue_global_state set running_count = 99 where id = 'global'",
      );
      expect(await reconcileQueueState(db, 10)).toBe(1);
      const [tenant] = await db.unsafe(
        "select account_id, running_count from public.queue_tenant_state where account_id = $1::uuid",
        [accountId],
      );
      expect(tenant).toEqual({ account_id: accountId, running_count: 0 });
      const [global] = await db.unsafe("select running_count from public.queue_global_state");
      expect(global).toEqual({ running_count: 0 });
    } finally {
      await db.unsafe("delete from public.job where id = $1::uuid", [jobId]);
      await db.unsafe("delete from public.outbox_event where account_id = $1::uuid", [accountId]);
      await db.unsafe("delete from public.queue_tenant_state where account_id = $1::uuid", [
        accountId,
      ]);
      await db.unsafe("delete from public.account where id = $1::uuid", [accountId]);
    }
  });
});
