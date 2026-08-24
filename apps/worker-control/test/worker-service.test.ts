import { describe, expect, it, vi } from "vitest";
import type { ArtifactManifest } from "@touchmyapi/contracts";
import {
  runDeliveryCycle,
  runExecutionCycle,
  type WorkerServiceDependencies,
} from "../src/service";

const accountId = "d0d5973a-12b8-4bec-8b76-692bd8e072dd";
const assessmentId = "dc37099e-9928-4656-b47c-026380311a3a";
const jobId = "71724aad-2914-4c36-8fd2-5fe279475206";

const manifest: ArtifactManifest = {
  schemaVersion: "job.artifacts@1",
  jobId,
  finishedAt: "2026-08-24T12:00:00.000Z",
  exit: { code: 0, signal: null },
  limitsUsed: { cpuS: 0.1, memMB: 10, durationS: 1 },
  artifacts: [],
  observations: [
    {
      actionId: "http.headers",
      kind: "http_headers",
      observedAt: "2026-08-24T11:59:59.000Z",
      data: { strictTransportSecurity: false, contentSecurityPolicy: true },
    },
  ],
  stopsTriggered: [],
  cleanup: { containerRemoved: true, tmpfsRemoved: true },
};

function dependencies(
  overrides: Partial<WorkerServiceDependencies> = {},
): WorkerServiceDependencies {
  return {
    workerId: "worker-test",
    sandboxImpl: "fixture",
    leaseSeconds: 120,
    claimJob: vi.fn(async () => ({
      jobId,
      accountId,
      status: "running" as const,
      leaseOwner: "worker-test",
      leaseExpiresAt: "2026-08-24T12:01:00.000Z",
      fencingToken: 1,
    })),
    loadClaimedJob: vi.fn(async () => ({
      accountId,
      jobId,
      assessmentId,
      playbookKey: "surface-public-posture",
      playbookVersion: "1.0.0",
      target: "https://example.com",
      scope: ["example.com"],
      limits: {},
      contract: {},
    })),
    heartbeatJob: vi.fn(async ({ accountId, jobId, leaseOwner, fencingToken }) => ({
      accountId,
      jobId,
      status: "running" as const,
      leaseOwner,
      leaseExpiresAt: "2026-08-24T12:02:00.000Z",
      fencingToken,
    })),
    execute: vi.fn(async () => manifest),
    recordResult: vi.fn(async () => true),
    completeJob: vi.fn(async () => ({
      jobId,
      accountId,
      status: "running" as const,
      leaseOwner: "worker-test",
      leaseExpiresAt: "2026-08-24T12:01:00.000Z",
      fencingToken: 1,
    })),
    failJob: vi.fn(async () => null),
    claimOutbox: vi.fn(async () => []),
    readResult: vi.fn(async () => manifest),
    publish: vi.fn(async () => true),
    prepareReports: vi.fn(async () => []),
    publishTerminal: vi.fn(async () => true),
    ackOutbox: vi.fn(async () => true),
    failOutbox: vi.fn(async () => true),
    ...overrides,
  };
}

describe("worker service cycles", () => {
  it("claims, executes, persists, and completes one fenced job", async () => {
    const deps = dependencies();
    await expect(runExecutionCycle(deps)).resolves.toBe(true);
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(deps.recordResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId, fencingToken: 1, manifest }),
    );
    expect(deps.completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId, fencingToken: 1 }),
    );
  });

  it("fails with a fixed safe reason and never copies runner errors", async () => {
    const deps = dependencies({
      execute: vi.fn(async () => {
        throw new Error("https://user:secret@example.com/?token=must-not-leak");
      }),
    });
    await expect(runExecutionCycle(deps)).resolves.toBe(false);
    expect(deps.failJob).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "runner_execution_failed" }),
    );
    expect(JSON.stringify(vi.mocked(deps.failJob).mock.calls)).not.toContain("must-not-leak");
  });

  it("renews the lease while execution is active", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies({
        leaseSeconds: 10,
        execute: vi.fn(
          () =>
            new Promise<ArtifactManifest>((resolve) => setTimeout(() => resolve(manifest), 4_000)),
        ),
      });
      const cycle = runExecutionCycle(deps);
      await vi.advanceTimersByTimeAsync(3_500);
      expect(deps.heartbeatJob).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(500);
      await expect(cycle).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts and never publishes a result after losing the lease", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(
        (_job, signal: AbortSignal) =>
          new Promise<ArtifactManifest>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("lease lost")), { once: true });
          }),
      );
      const deps = dependencies({
        leaseSeconds: 10,
        heartbeatJob: vi.fn(async () => null),
        execute,
      });
      const cycle = runExecutionCycle(deps);
      await vi.advanceTimersByTimeAsync(3_500);
      await expect(cycle).resolves.toBe(false);
      expect(deps.recordResult).not.toHaveBeenCalled();
      expect(deps.completeJob).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("analyzes a successful delivery event and acknowledges only after publication", async () => {
    const deps = dependencies({
      claimOutbox: vi.fn(async () => [
        {
          id: "91b427d6-d61d-47e0-a0d2-b1dd594a0bf6",
          accountId,
          eventKey: `job:${jobId}:delivery:1`,
          aggregateType: "job_delivery",
          aggregateId: jobId,
          schemaVersion: "job.delivery@1",
          attempts: 0,
          maxAttempts: 5,
          leaseOwner: "worker-test",
          leaseExpiresAt: "2026-08-24T12:01:00.000Z",
          fencingToken: 1,
        },
      ]),
    });
    await expect(runDeliveryCycle(deps)).resolves.toBe(1);
    expect(deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        jobId,
        jobFencingToken: 1,
        findings: [expect.objectContaining({ sourceKey: "http.headers:hsts_missing" })],
        reports: [],
      }),
    );
    expect(deps.ackOutbox).toHaveBeenCalledOnce();
  });

  it("publishes terminal state before acknowledging a terminal event", async () => {
    const deps = dependencies({
      claimOutbox: vi.fn(async () => [
        {
          id: "91b427d6-d61d-47e0-a0d2-b1dd594a0bf6",
          accountId,
          eventKey: `job:${jobId}:terminal:1`,
          aggregateType: "job_delivery",
          aggregateId: jobId,
          schemaVersion: "job.delivery@1",
          attempts: 0,
          maxAttempts: 5,
          leaseOwner: "worker-test",
          leaseExpiresAt: "2026-08-24T12:01:00.000Z",
          fencingToken: 1,
        },
      ]),
    });
    await expect(runDeliveryCycle(deps)).resolves.toBe(1);
    expect(deps.publishTerminal).toHaveBeenCalledWith({
      accountId,
      jobId,
      jobFencingToken: 1,
    });
    expect(deps.ackOutbox).toHaveBeenCalledOnce();
  });
});
