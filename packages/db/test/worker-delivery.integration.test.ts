import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTenantDatabase,
  createTenantDatabase,
  type TenantDatabase,
} from "../src/connection-internal";
import { claimQueueJob, completeQueueJob } from "../src/queue-control";
import {
  publishSucceededJob,
  publishTerminalJob,
  readClaimedWorkerJob,
  readSucceededRunnerResult,
  recordClaimedRunnerResult,
} from "../src/worker-delivery";
import { withTenant } from "../src/tenant-session";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const connectorPassword = "worker-connector-test-secret";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for worker delivery tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Worker delivery tests require a loopback *_test database");
  }
  return value;
}

function workerUrl(ownerUrl: string): string {
  const parsed = new URL(ownerUrl);
  parsed.username = "worker_connector";
  parsed.password = connectorPassword;
  return parsed.toString();
}

describe.skipIf(!RUN_DB_TESTS)("worker tenant delivery", () => {
  let owner!: RawDbConnection;
  let worker!: TenantDatabase;

  beforeAll(async () => {
    const url = databaseUrlForTest();
    owner = createRawDbConnection(url);
    await owner.unsafe(`alter role worker_connector password '${connectorPassword}'`);
    worker = createTenantDatabase(workerUrl(url));
  });

  afterAll(async () => {
    if (worker) await closeTenantDatabase(worker);
    if (owner) await owner.end();
  });

  it("records a current fenced result and publishes customer delivery exactly once", async () => {
    const accountId = crypto.randomUUID();
    const foreignAccountId = crypto.randomUUID();
    const assessmentId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const playbookKey = `worker-delivery-${jobId}`;
    try {
      await owner.unsafe("insert into public.account (id) values ($1::uuid), ($2::uuid)", [
        accountId,
        foreignAccountId,
      ]);
      await owner.unsafe("insert into public.audit_account_state (account_id) values ($1::uuid)", [
        accountId,
      ]);
      await owner.unsafe(
        `insert into public.playbook (key, playbook_version, target_category, contract_json)
         values ($1, '1.0.0', 'surface', '{"actions":[]}'::jsonb)`,
        [playbookKey],
      );
      await owner.unsafe(
        `insert into public.assessment (
           id, account_id, target_category, target_json, scope_json, playbook_id,
           playbook_version, limits_json, status
         ) values (
           $1::uuid, $2::uuid, 'surface', '{"value":"https://example.com"}'::jsonb,
           '["example.com"]'::jsonb, $3, '1.0.0',
           '{"maxDurationS":300,"maxConcurrency":1,"maxRatePerMin":10}'::jsonb,
           'queued'
         )`,
        [assessmentId, accountId, playbookKey],
      );
      await owner.unsafe(
        `insert into public.job (
           id, account_id, assessment_id, playbook_version, job_spec_json, status,
           available_at, normalized_target_key, dedupe_key
         ) values (
           $1::uuid, $2::uuid, $3::uuid, '1.0.0',
           jsonb_build_object('schemaVersion','job.spec@1','jobId',$1::uuid,'assessmentId',$3::uuid),
           'queued', now(), 'example.com', $4
         )`,
        [jobId, accountId, assessmentId, `dedupe:${jobId}`],
      );

      const claim = await claimQueueJob(owner, "worker-delivery", 120);
      expect(claim).toMatchObject({ jobId, accountId, fencingToken: 1 });

      const foreign = await withTenant(worker, foreignAccountId, "worker_rls", (context) =>
        readClaimedWorkerJob(context, {
          jobId,
          leaseOwner: "worker-delivery",
          fencingToken: 1,
        }),
      );
      expect(foreign).toBeUndefined();

      const input = await withTenant(worker, accountId, "worker_rls", (context) =>
        readClaimedWorkerJob(context, {
          jobId,
          leaseOwner: "worker-delivery",
          fencingToken: 1,
        }),
      );
      expect(input).toMatchObject({
        accountId,
        jobId,
        assessmentId,
        target: "https://example.com",
        scope: ["example.com"],
      });

      const manifest = {
        schemaVersion: "job.artifacts@1" as const,
        jobId,
        finishedAt: new Date().toISOString(),
        exit: { code: 0, signal: null },
        limitsUsed: { cpuS: 0.1, memMB: 12, durationS: 1 },
        artifacts: [],
        observations: [],
        stopsTriggered: [],
        cleanup: { containerRemoved: true, tmpfsRemoved: true },
      };
      expect(
        await withTenant(worker, accountId, "worker_rls", (context) =>
          recordClaimedRunnerResult(context, {
            jobId,
            leaseOwner: "worker-delivery",
            fencingToken: 1,
            sandboxImpl: "fixture",
            manifest,
          }),
        ),
      ).toBe(true);
      expect(
        await withTenant(worker, accountId, "worker_rls", (context) =>
          recordClaimedRunnerResult(context, {
            jobId,
            leaseOwner: "worker-delivery",
            fencingToken: 99,
            sandboxImpl: "fixture",
            manifest,
          }),
        ),
      ).toBe(false);

      await completeQueueJob(owner, accountId, jobId, "worker-delivery", 1);
      expect(
        await withTenant(worker, accountId, "worker_rls", (context) =>
          readSucceededRunnerResult(context, { jobId, fencingToken: 1 }),
        ),
      ).toEqual(manifest);
      const finding = {
        sourceKey: "http.headers:hsts_missing",
        title: "HTTP Strict Transport Security was not observed",
        category: "transport",
        severity: "low" as const,
        endpoint: "https://example.com/",
        evidence: { strictTransportSecurity: false },
        reproduction: [] as const,
        impact: "First visits have weaker downgrade resistance.",
        remediation: "Enable HSTS after validating HTTPS coverage.",
      };
      const reports = (["json", "pdf_technical", "pdf_executive"] as const).map((kind) => ({
        kind,
        objectKey: `reports/${accountId}/${assessmentId}/${kind}`,
        contractVersion: "report.json@1",
      }));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          await withTenant(worker, accountId, "worker_rls", (context) =>
            publishSucceededJob(context, {
              jobId,
              fencingToken: 1,
              findings: [finding],
              reports,
            }),
          ),
        ).toBe(true);
      }

      const [counts] = await owner.unsafe(
        `select
           (select count(*)::int from public.finding where assessment_id = $1::uuid) as findings,
           (select count(*)::int from public.notification where assessment_id = $1::uuid) as notifications,
           (select count(*)::int from public.report where assessment_id = $1::uuid) as reports,
           (select count(*)::int from public.audit_event
              where assessment_id = $1::uuid or job_id = $2::uuid) as audit_events,
           (select status from public.assessment where id = $1::uuid) as assessment_status`,
        [assessmentId, jobId],
      );
      expect(counts).toEqual({
        findings: 1,
        notifications: 1,
        reports: 3,
        audit_events: 4,
        assessment_status: "completed",
      });
    } finally {
      await owner.unsafe("delete from public.outbox_event where aggregate_id = $1::uuid", [jobId]);
      await owner.unsafe("delete from public.notification where assessment_id = $1::uuid", [
        assessmentId,
      ]);
      await owner.unsafe("delete from public.report where assessment_id = $1::uuid", [
        assessmentId,
      ]);
      await owner.unsafe("delete from public.finding where assessment_id = $1::uuid", [
        assessmentId,
      ]);
      await owner.unsafe("delete from public.runner_execution where job_id = $1::uuid", [jobId]);
      await owner.unsafe(
        "delete from public.audit_event where assessment_id = $1::uuid or job_id = $2::uuid",
        [assessmentId, jobId],
      );
      await owner.unsafe("delete from public.job where id = $1::uuid", [jobId]);
      await owner.unsafe("delete from public.assessment where id = $1::uuid", [assessmentId]);
      await owner.unsafe("delete from public.playbook where key = $1", [playbookKey]);
      await owner.unsafe("delete from public.audit_account_state where account_id = $1::uuid", [
        accountId,
      ]);
      await owner.unsafe(
        "delete from public.queue_tenant_state where account_id in ($1::uuid, $2::uuid)",
        [accountId, foreignAccountId],
      );
      await owner.unsafe("delete from public.account where id in ($1::uuid, $2::uuid)", [
        accountId,
        foreignAccountId,
      ]);
    }
  });

  it("publishes one failure notification only for the current terminal fence", async () => {
    const accountId = crypto.randomUUID();
    const assessmentId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const playbookKey = `worker-terminal-${jobId}`;
    try {
      await owner.unsafe("insert into public.account (id) values ($1::uuid)", [accountId]);
      await owner.unsafe(
        `insert into public.playbook (key, playbook_version, target_category, contract_json)
         values ($1, '1.0.0', 'surface', '{"actions":[]}'::jsonb)`,
        [playbookKey],
      );
      await owner.unsafe(
        `insert into public.assessment (
           id, account_id, target_category, target_json, scope_json, playbook_id,
           playbook_version, limits_json, status, failure_reason
         ) values (
           $1::uuid, $2::uuid, 'surface', '{"value":"https://example.com"}'::jsonb,
           '[]'::jsonb, $3, '1.0.0', '{}'::jsonb, 'failed', 'runner_execution_failed'
         )`,
        [assessmentId, accountId, playbookKey],
      );
      await owner.unsafe(
        `insert into public.job (
           id, account_id, assessment_id, playbook_version, job_spec_json, status,
           available_at, normalized_target_key, dedupe_key, fencing_token, failure_reason
         ) values (
           $1::uuid, $2::uuid, $3::uuid, '1.0.0', '{}'::jsonb, 'failed', now(),
           'example.com', $4, 4, 'runner_execution_failed'
         )`,
        [jobId, accountId, assessmentId, `dedupe:${jobId}`],
      );

      expect(
        await withTenant(worker, accountId, "worker_rls", (context) =>
          publishTerminalJob(context, { jobId, fencingToken: 3 }),
        ),
      ).toBe(false);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          await withTenant(worker, accountId, "worker_rls", (context) =>
            publishTerminalJob(context, { jobId, fencingToken: 4 }),
          ),
        ).toBe(true);
      }
      const [count] = await owner.unsafe(
        `select count(*)::int as notifications from public.notification
         where account_id = $1::uuid and assessment_id = $2::uuid
           and kind = 'assessment_failed'`,
        [accountId, assessmentId],
      );
      expect(count?.notifications).toBe(1);
    } finally {
      await owner.unsafe("delete from public.notification where assessment_id = $1::uuid", [
        assessmentId,
      ]);
      await owner.unsafe("delete from public.job where id = $1::uuid", [jobId]);
      await owner.unsafe("delete from public.assessment where id = $1::uuid", [assessmentId]);
      await owner.unsafe("delete from public.playbook where key = $1", [playbookKey]);
      await owner.unsafe("delete from public.queue_tenant_state where account_id = $1::uuid", [
        accountId,
      ]);
      await owner.unsafe("delete from public.account where id = $1::uuid", [accountId]);
    }
  });
});
