import {
  ackOutboxEvent,
  claimOutboxEvents,
  claimQueueJob,
  closeTenantDatabase,
  completeQueueJob,
  createTenantDatabase,
  failOutboxEvent,
  failQueueJob,
  heartbeatQueueJob,
  publishSucceededJob,
  publishTerminalJob,
  readClaimedWorkerJob,
  readSucceededReportContext,
  readSucceededRunnerResult,
  recordClaimedRunnerResult,
  withTenant,
} from "@touchmyapi/db";
import {
  createRawDbConnection,
  type RawDbConnection,
  type TenantDatabase,
} from "../../../packages/db/src/connection-internal";
import {
  generateReportObjects,
  S3CompatiblePrivateReportStorage,
  stableFindingId,
} from "@touchmyapi/reporting";
import { loadWorkerConfig, type WorkerConfig } from "./config";
import { createFixtureRunner, type PassiveRunner } from "./fixture-runner";
import { runDeliveryCycle, runExecutionCycle, type WorkerServiceDependencies } from "./service";

export type WorkerRuntime = Readonly<{
  config: WorkerConfig;
  dependencies: WorkerServiceDependencies;
  close: () => Promise<void>;
}>;

function runnerFor(config: WorkerConfig): PassiveRunner {
  if (config.runnerMode === "fixture") return createFixtureRunner(config.environment);
  throw new Error("isolated runner adapter is unavailable");
}

async function assertQueueConnector(queue: RawDbConnection): Promise<void> {
  const rows = await queue.unsafe("select current_user as role");
  if (rows[0]?.role !== "queue_connector") throw new Error("queue connector rejected");
}

async function assertWorkerConnector(database: TenantDatabase): Promise<void> {
  await withTenant(
    database,
    "00000000-0000-4000-8000-000000000000",
    "worker_rls",
    async (context) => {
      await context.account.readCurrent();
    },
  );
}

export async function createWorkerRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<WorkerRuntime> {
  const config = loadWorkerConfig(env);
  const runner = runnerFor(config);
  const queue = createRawDbConnection(config.queueDatabaseUrl);
  const worker = createTenantDatabase(config.workerDatabaseUrl);
  const reportStorage = new S3CompatiblePrivateReportStorage(config.storage);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([queue.end(), closeTenantDatabase(worker)]);
  };
  try {
    await assertQueueConnector(queue);
    await assertWorkerConnector(worker);
    await reportStorage.ensurePrivateBucket();
    const dependencies: WorkerServiceDependencies = {
      workerId: config.workerId,
      sandboxImpl: runner.kind,
      leaseSeconds: config.leaseSeconds,
      claimJob: () => claimQueueJob(queue, config.workerId, config.leaseSeconds),
      heartbeatJob: (input) =>
        heartbeatQueueJob(
          queue,
          input.accountId,
          input.jobId,
          input.leaseOwner,
          input.fencingToken,
          config.leaseSeconds,
        ),
      loadClaimedJob: ({ accountId, ...reference }) =>
        withTenant(worker, accountId, "worker_rls", (context) =>
          readClaimedWorkerJob(context, reference),
        ),
      execute: runner.execute,
      recordResult: ({ accountId, ...input }) =>
        withTenant(worker, accountId, "worker_rls", (context) =>
          recordClaimedRunnerResult(context, input),
        ),
      completeJob: (input) =>
        completeQueueJob(queue, input.accountId, input.jobId, input.leaseOwner, input.fencingToken),
      failJob: (input) =>
        failQueueJob(
          queue,
          input.accountId,
          input.jobId,
          input.leaseOwner,
          input.fencingToken,
          input.reason,
        ),
      claimOutbox: () => claimOutboxEvents(queue, config.workerId, 25),
      readResult: ({ accountId, ...reference }) =>
        withTenant(worker, accountId, "worker_rls", (context) =>
          readSucceededRunnerResult(context, reference),
        ),
      prepareReports: async ({ accountId, jobId, jobFencingToken, manifest, analysis }) => {
        const reportContext = await withTenant(worker, accountId, "worker_rls", (context) =>
          readSucceededReportContext(context, {
            jobId,
            fencingToken: jobFencingToken,
          }),
        );
        if (!reportContext) throw new Error("report source unavailable");
        const reportObjects = await generateReportObjects(
          accountId,
          {
            schemaVersion: "report.json@1",
            assessmentId: reportContext.assessmentId,
            generatedAt: manifest.finishedAt,
            plan: reportContext.plan,
            target: { value: reportContext.target },
            scope: {
              inclusions:
                reportContext.scope.length > 0 ? [...reportContext.scope] : [reportContext.target],
              exclusions: [],
              window: { start: reportContext.startedAt, end: manifest.finishedAt },
            },
            playbook: {
              key: reportContext.playbookKey,
              version: reportContext.playbookVersion,
            },
            methodology: [
              "Deterministic passive public-posture analysis of approved catalog observations.",
            ],
            limitations: [
              ...analysis.limitations,
              ...analysis.untestedActions.map((action) => `Untested catalog action: ${action}`),
            ],
            findings: analysis.findings.map((finding) => ({
              id: stableFindingId(reportContext.assessmentId, finding.sourceKey),
              title: finding.title,
              category: finding.category,
              severity: finding.severity,
              evidence: finding.evidence,
              reproduction: [...finding.reproduction],
              impact: finding.impact,
              remediation: finding.remediation,
            })),
            credits: {
              consumed: reportContext.creditsConsumed,
              estimate: reportContext.creditsEstimate,
            },
          },
          reportContext.plan,
        );
        for (const report of reportObjects) {
          await reportStorage.put(report.objectKey, report.body, report.contentType);
        }
        return reportObjects.map(({ kind, objectKey, contractVersion }) => ({
          kind,
          objectKey,
          contractVersion,
        }));
      },
      publish: ({ accountId, jobFencingToken, ...input }) =>
        withTenant(worker, accountId, "worker_rls", (context) =>
          publishSucceededJob(context, {
            ...input,
            fencingToken: jobFencingToken,
          }),
        ),
      publishTerminal: ({ accountId, jobFencingToken, jobId }) =>
        withTenant(worker, accountId, "worker_rls", (context) =>
          publishTerminalJob(context, { jobId, fencingToken: jobFencingToken }),
        ),
      ackOutbox: (input) =>
        ackOutboxEvent(queue, input.accountId, input.eventId, input.leaseOwner, input.fencingToken),
      failOutbox: (input) =>
        failOutboxEvent(
          queue,
          input.accountId,
          input.eventId,
          input.leaseOwner,
          input.fencingToken,
          input.reason,
        ),
    };
    return Object.freeze({ config, dependencies: Object.freeze(dependencies), close });
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runWorkerLoop(runtime: WorkerRuntime, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let progressed = false;
    try {
      const delivered = await runDeliveryCycle(runtime.dependencies);
      const executed = await runExecutionCycle(runtime.dependencies);
      progressed = delivered > 0 || executed;
    } catch {
      console.error("[worker] bounded cycle failed");
    }
    if (!progressed && !signal.aborted) {
      await Bun.sleep(runtime.config.pollIntervalMs);
    }
  }
}
