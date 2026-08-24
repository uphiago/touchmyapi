import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";
import { claimQueueJob } from "../src/queue-control";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for queue fairness tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Queue fairness tests require a loopback *_test database");
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("queue fair claim concurrency", () => {
  let db!: RawDbConnection;
  let peer!: RawDbConnection;

  beforeAll(() => {
    const url = databaseUrlForTest();
    db = createRawDbConnection(url);
    peer = createRawDbConnection(url);
  });

  afterAll(async () => {
    await Promise.all([db?.end(), peer?.end()]);
  });

  it("claims distinct tenants concurrently in deterministic fairness order", async () => {
    const fixtures = await Promise.all(
      ["a", "b"].map(async (suffix) => {
        const accountId = crypto.randomUUID();
        const assessmentId = crypto.randomUUID();
        const jobId = crypto.randomUUID();
        const playbookKey = `queue-fair-${suffix}-${accountId}`;
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
          "insert into public.job (id, account_id, assessment_id, playbook_version, job_spec_json, status, available_at, priority, normalized_target_key, attempts, max_attempts, fencing_token, dedupe_key) values ($1::uuid, $2::uuid, $3::uuid, '1.0.0', '{}'::jsonb, 'queued', now(), 0, $4, 0, 3, 0, $5)",
          [jobId, accountId, assessmentId, `fair-${suffix}.example`, `fair-${jobId}`],
        );
        return { accountId, assessmentId, jobId, playbookKey };
      }),
    );
    try {
      const [first, second] = await Promise.all([
        claimQueueJob(db, "fair-worker-a", 60),
        claimQueueJob(peer, "fair-worker-b", 60),
      ]);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(new Set([first?.jobId, second?.jobId])).toEqual(
        new Set(fixtures.map((fixture) => fixture.jobId)),
      );
      expect(new Set([first?.accountId, second?.accountId])).toEqual(
        new Set(fixtures.map((fixture) => fixture.accountId)),
      );
      expect([first?.fencingToken, second?.fencingToken]).toEqual([1, 1]);
      const [global] = await db.unsafe("select running_count from public.queue_global_state");
      expect(global).toEqual({ running_count: 2 });
    } finally {
      for (const fixture of fixtures) {
        await db.unsafe("delete from public.job where id = $1::uuid", [fixture.jobId]);
        await db.unsafe("delete from public.assessment where id = $1::uuid", [
          fixture.assessmentId,
        ]);
        await db.unsafe("delete from public.playbook where key = $1", [fixture.playbookKey]);
        await db.unsafe("delete from public.queue_tenant_state where account_id = $1::uuid", [
          fixture.accountId,
        ]);
        await db.unsafe("delete from public.account where id = $1::uuid", [fixture.accountId]);
      }
      await db.unsafe("update public.queue_global_state set running_count = 0 where id = 'global'");
    }
  });
});
