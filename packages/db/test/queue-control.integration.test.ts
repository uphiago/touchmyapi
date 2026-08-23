import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";
import { claimQueueJob } from "../src/queue-control";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for queue control tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Queue control tests require a loopback *_test database");
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("queue control claim boundary", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForTest());
  });

  afterAll(async () => db?.end());

  it("claims one eligible job with a fencing token and exact counters", async () => {
    const accountId = crypto.randomUUID();
    const assessmentId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const playbookKey = "queue-control-" + accountId;
    try {
      await db.unsafe("insert into public.account (id) values ($1::uuid)", [accountId]);
      await db.unsafe(
        "insert into public.playbook (key, playbook_version, target_category, contract_json) values ($1, '1.0.0', 'surface', '{}'::jsonb)",
        [playbookKey],
      );
      await db.unsafe(
        "insert into public.assessment (id, account_id, target_category, target_json, scope_json, playbook_id, playbook_version, limits_json) values ($1::uuid, $2::uuid, 'surface', '{}'::jsonb, '{}'::jsonb, $3, '1.0.0', '{}'::jsonb)",
        [assessmentId, accountId, playbookKey],
      );
      await db.unsafe(
        "insert into public.job (id, account_id, assessment_id, playbook_version, job_spec_json, status, available_at, priority, normalized_target_key, attempts, max_attempts, fencing_token, dedupe_key) values ($1::uuid, $2::uuid, $3::uuid, '1.0.0', '{}'::jsonb, 'queued', now(), 10, 'queue-control.example', 0, 3, 0, $4)",
        [jobId, accountId, assessmentId, "dedupe-" + jobId],
      );

      const claimed = await claimQueueJob(db, "worker-a", 60);
      expect(claimed).toMatchObject({
        jobId,
        accountId,
        status: "running",
        leaseOwner: "worker-a",
        fencingToken: 1,
      });
      const [job] = await db.unsafe(
        "select status, lease_owner, fencing_token from public.job where id = $1::uuid",
        [jobId],
      );
      const [global] = await db.unsafe("select running_count from public.queue_global_state");
      const [tenant] = await db.unsafe(
        "select running_count from public.queue_tenant_state where account_id = $1::uuid",
        [accountId],
      );
      expect(job).toEqual({ status: "running", lease_owner: "worker-a", fencing_token: 1 });
      expect(global).toEqual({ running_count: 1 });
      expect(tenant).toEqual({ running_count: 1 });
    } finally {
      await db.unsafe("delete from public.job where id = $1::uuid", [jobId]);
      await db.unsafe("delete from public.assessment where id = $1::uuid", [assessmentId]);
      await db.unsafe("delete from public.playbook where key = $1", [playbookKey]);
      await db.unsafe("delete from public.queue_tenant_state where account_id = $1::uuid", [
        accountId,
      ]);
      await db.unsafe("delete from public.account where id = $1::uuid", [accountId]);
    }
  });
});
