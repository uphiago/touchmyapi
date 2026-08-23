import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";
import { enqueueJob } from "../src/queue";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for queue enqueue tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Queue enqueue tests require a loopback *_test database");
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("tenant queue enqueue boundary", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForTest());
  });

  afterAll(async () => db?.end());

  it("atomically inserts an operational job and redacted outbox intent", async () => {
    const accountId = crypto.randomUUID();
    const assessmentId = crypto.randomUUID();
    const playbookKey = "queue-enqueue-" + accountId;
    let jobId = "";
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
      jobId = await enqueueJob(db, {
        accountId,
        assessmentId,
        normalizedTargetKey: "example.com",
        priority: 5,
        maxAttempts: 3,
      });
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/u);
      const [job] = await db.unsafe(
        "select account_id, assessment_id, status, normalized_target_key, priority, max_attempts from public.job where id = $1::uuid",
        [jobId],
      );
      expect(job).toEqual({
        account_id: accountId,
        assessment_id: assessmentId,
        status: "queued",
        normalized_target_key: "example.com",
        priority: 5,
        max_attempts: 3,
      });
      const [event] = await db.unsafe(
        "select account_id, event_key, aggregate_type, aggregate_id, schema_version, status, payload_json from public.outbox_event where aggregate_id = $1::uuid",
        [jobId],
      );
      expect(event).toMatchObject({
        account_id: accountId,
        event_key: "job:" + jobId,
        aggregate_type: "job",
        aggregate_id: jobId,
        schema_version: "job.event@1",
        status: "pending",
        payload_json: { event: "job_queued", jobId },
      });
      expect(JSON.stringify(event)).not.toContain("credential");
    } finally {
      if (jobId)
        await db.unsafe("delete from public.outbox_event where aggregate_id = $1::uuid", [jobId]);
      if (jobId) await db.unsafe("delete from public.job where id = $1::uuid", [jobId]);
      await db.unsafe("delete from public.assessment where id = $1::uuid", [assessmentId]);
      await db.unsafe("delete from public.playbook where key = $1", [playbookKey]);
      await db.unsafe("delete from public.queue_tenant_state where account_id = $1::uuid", [
        accountId,
      ]);
      await db.unsafe("delete from public.account where id = $1::uuid", [accountId]);
    }
  });
});
