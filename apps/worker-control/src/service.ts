import { analyzePassiveObservations } from "@touchmyapi/analysis";
import type { ArtifactManifest } from "@touchmyapi/contracts";
import type {
  ClaimedWorkerJob,
  OutboxClaim,
  QueueClaim,
  ReportPublicationInput,
} from "@touchmyapi/db";

type ExecutionRef = Readonly<{
  accountId: string;
  jobId: string;
  leaseOwner: string;
  fencingToken: number;
}>;

type OutboxRef = Readonly<{
  accountId: string;
  eventId: string;
  leaseOwner: string;
  fencingToken: number;
}>;

export type WorkerServiceDependencies = Readonly<{
  workerId: string;
  sandboxImpl: string;
  leaseSeconds: number;
  claimJob: () => Promise<QueueClaim | null>;
  heartbeatJob: (input: ExecutionRef) => Promise<QueueClaim | null>;
  loadClaimedJob: (input: ExecutionRef) => Promise<ClaimedWorkerJob | undefined>;
  execute: (job: ClaimedWorkerJob, signal: AbortSignal) => Promise<ArtifactManifest>;
  recordResult: (
    input: ExecutionRef & {
      sandboxImpl: string;
      manifest: ArtifactManifest;
    },
  ) => Promise<boolean>;
  completeJob: (input: ExecutionRef) => Promise<unknown | null>;
  failJob: (input: ExecutionRef & { reason: string }) => Promise<unknown | null>;
  claimOutbox: () => Promise<readonly OutboxClaim[]>;
  readResult: (input: {
    accountId: string;
    jobId: string;
    fencingToken: number;
  }) => Promise<ArtifactManifest | undefined>;
  publish: (input: {
    accountId: string;
    jobId: string;
    jobFencingToken: number;
    findings: ReturnType<typeof analyzePassiveObservations>["findings"];
    reports: readonly ReportPublicationInput[];
  }) => Promise<boolean>;
  prepareReports: (input: {
    accountId: string;
    jobId: string;
    jobFencingToken: number;
    manifest: ArtifactManifest;
    analysis: ReturnType<typeof analyzePassiveObservations>;
  }) => Promise<readonly ReportPublicationInput[]>;
  publishTerminal: (input: {
    accountId: string;
    jobId: string;
    jobFencingToken: number;
  }) => Promise<boolean>;
  ackOutbox: (input: OutboxRef) => Promise<boolean>;
  failOutbox: (input: OutboxRef & { reason: string }) => Promise<boolean>;
}>;

function waitForHeartbeat(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function executionRef(claim: QueueClaim): ExecutionRef {
  return {
    accountId: claim.accountId,
    jobId: claim.jobId,
    leaseOwner: claim.leaseOwner,
    fencingToken: claim.fencingToken,
  };
}

function outboxRef(event: OutboxClaim): OutboxRef {
  return {
    accountId: event.accountId,
    eventId: event.id,
    leaseOwner: event.leaseOwner,
    fencingToken: event.fencingToken,
  };
}

export async function runExecutionCycle(dependencies: WorkerServiceDependencies): Promise<boolean> {
  const claim = await dependencies.claimJob();
  if (!claim) return false;
  const reference = executionRef(claim);
  try {
    const job = await dependencies.loadClaimedJob(reference);
    if (!job) return false;
    const controller = new AbortController();
    let leaseLost = false;
    const heartbeatIntervalMs = Math.max(
      1_000,
      Math.floor((dependencies.leaseSeconds * 1_000) / 3),
    );
    const heartbeat = (async () => {
      while (!controller.signal.aborted) {
        await waitForHeartbeat(heartbeatIntervalMs, controller.signal);
        if (controller.signal.aborted) return;
        try {
          if (!(await dependencies.heartbeatJob(reference))) {
            leaseLost = true;
            controller.abort();
          }
        } catch {
          leaseLost = true;
          controller.abort();
        }
      }
    })();
    let manifest: ArtifactManifest;
    try {
      manifest = await dependencies.execute(job, controller.signal);
    } finally {
      controller.abort();
      await heartbeat;
    }
    if (leaseLost) return false;
    const recorded = await dependencies.recordResult({
      ...reference,
      sandboxImpl: dependencies.sandboxImpl,
      manifest,
    });
    if (!recorded) return false;
    return (await dependencies.completeJob(reference)) !== null;
  } catch {
    await dependencies.failJob({ ...reference, reason: "runner_execution_failed" });
    return false;
  }
}

function jobFence(event: OutboxClaim): number | undefined {
  const matched = /:(?:delivery|terminal):(\d+)$/u.exec(event.eventKey);
  if (!matched) return undefined;
  const parsed = Number(matched[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function runDeliveryCycle(dependencies: WorkerServiceDependencies): Promise<number> {
  const events = await dependencies.claimOutbox();
  let delivered = 0;
  for (const event of events) {
    const reference = outboxRef(event);
    try {
      if (
        event.schemaVersion === "job.delivery@1" &&
        event.aggregateType === "job_delivery" &&
        event.aggregateId
      ) {
        const fencingToken = jobFence(event);
        if (fencingToken === undefined) throw new Error("invalid delivery event");
        if (event.eventKey.includes(":delivery:")) {
          const manifest = await dependencies.readResult({
            accountId: event.accountId,
            jobId: event.aggregateId,
            fencingToken,
          });
          if (!manifest) throw new Error("runner result unavailable");
          const analysis = analyzePassiveObservations(manifest.observations ?? []);
          const reports = await dependencies.prepareReports({
            accountId: event.accountId,
            jobId: event.aggregateId,
            jobFencingToken: fencingToken,
            manifest,
            analysis,
          });
          const published = await dependencies.publish({
            accountId: event.accountId,
            jobId: event.aggregateId,
            jobFencingToken: fencingToken,
            findings: analysis.findings,
            reports,
          });
          if (!published) throw new Error("delivery publication rejected");
          delivered += 1;
        } else if (event.eventKey.includes(":terminal:")) {
          const published = await dependencies.publishTerminal({
            accountId: event.accountId,
            jobId: event.aggregateId,
            jobFencingToken: fencingToken,
          });
          if (!published) throw new Error("terminal publication rejected");
          delivered += 1;
        }
      }
      if (!(await dependencies.ackOutbox(reference))) {
        throw new Error("outbox acknowledgement rejected");
      }
    } catch {
      await dependencies.failOutbox({ ...reference, reason: "delivery_publication_failed" });
    }
  }
  return delivered;
}
