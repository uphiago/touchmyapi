import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";
import { claimQueueJob, reapQueueJobs } from "../src/queue-control";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for queue recovery tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Queue recovery tests require a loopback *_test database");
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("queue lease recovery", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForTest());
  });

  afterAll(async () => db?.end());

  it("recovers an expired lease with bounded backoff and decrements counters", async () => {
    const accountId = crypto.randomUUID();
    const assessmentId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const playbookKey = "queue-recovery-" + accountId;
    const claimedAt = new Date("2026-08-23T12:00:00.000Z");
    const reapedAt = new Date("2026-08-23T12:00:02.000Z");
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
        "insert into public.job (id, account_id, assessment_id, playbook_version, job_spec_json, status, available_at, priority, normalized_target_key, attempts, max_attempts, fencing_token, dedupe_key) values ($1::uuid, $2::uuid, $3::uuid, '1.0.0', '{}'::jsonb, 'queued', $4, 1, 'recovery.example', 0, 3, 0, $5)",
        [jobId, accountId, assessmentId, claimedAt, "recovery-" + jobId],
      );
      await expect(claimQueueJob(db, "worker-recovery", 1, claimedAt)).resolves.toMatchObject({
        jobId,
        fencingToken: 1,
      });
      await expect(reapQueueJobs(db, 10, reapedAt)).resolves.toBe(1);
      const [job] = await db.unsafe(
        "select status, attempts, fencing_token, lease_owner, failure_reason, available_at from public.job where id = $1::uuid",
        [jobId],
      );
      if (!job) throw new Error("recovery job fixture missing");
      expect(job).toMatchObject({
        status: "stale_recovered",
        attempts: 1,
        fencing_token: 1,
        lease_owner: null,
        failure_reason: "lease_expired",
      });
      expect(new Date(job.available_at).getTime()).toBe(reapedAt.getTime() + 10_000);
      const [global] = await db.unsafe("select running_count from public.queue_global_state");
      const [tenant] = await db.unsafe(
        "select running_count from public.queue_tenant_state where account_id = $1::uuid",
        [accountId],
      );
      expect(global).toEqual({ running_count: 0 });
      expect(tenant).toEqual({ running_count: 0 });
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
