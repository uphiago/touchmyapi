import { describe, expect, it } from "vitest";
import {
  outboxEventSchema,
  outboxStatusSchema,
  queueEnqueueRequestSchema,
  queueGlobalStateSchema,
  queueJobOperationalSchema,
  queueStatusSchema,
  queueTenantStateSchema,
} from "../src/queue";

const accountId = "123e4567-e89b-12d3-a456-426614174000";
const jobId = "123e4567-e89b-12d3-a456-426614174001";

describe("queue contracts", () => {
  it("keeps statuses and operational state closed", () => {
    expect(queueStatusSchema.options).toEqual([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "stale_recovered",
    ]);
    expect(outboxStatusSchema.options).toEqual(["pending", "processing", "processed", "failed"]);
    expect(() =>
      queueGlobalStateSchema.parse({
        id: "global",
        runningCount: 0,
        concurrencyLimit: 4,
        updatedAt: "2026-08-23T12:00:00Z",
        payload: "forbidden",
      }),
    ).toThrow();
  });

  it("accepts bounded enqueue input and rejects payload/secret fields", () => {
    expect(
      queueEnqueueRequestSchema.parse({
        accountId,
        assessmentId: jobId,
        normalizedTargetKey: "example.com",
        priority: 10,
        maxAttempts: 3,
        availableAt: "2026-08-23T12:00:00Z",
      }),
    ).toMatchObject({ accountId, normalizedTargetKey: "example.com" });
    expect(() =>
      queueEnqueueRequestSchema.parse({
        accountId,
        assessmentId: jobId,
        normalizedTargetKey: "example.com",
        jobSpec: { credential: "never" },
      }),
    ).toThrow();
  });

  it("models queue, tenant, job, and outbox operational records", () => {
    expect(
      queueTenantStateSchema.parse({
        accountId,
        lastDispatchedAt: null,
        runningCount: 0,
        concurrencyLimit: 2,
        updatedAt: "2026-08-23T12:00:00Z",
      }),
    ).toMatchObject({ accountId, runningCount: 0 });
    expect(
      queueJobOperationalSchema.parse({
        id: jobId,
        accountId,
        status: "queued",
        availableAt: "2026-08-23T12:00:00Z",
        priority: 0,
        attempts: 0,
        maxAttempts: 3,
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: 0,
        startedAt: null,
        stopRequestedAt: null,
        failureReason: null,
        createdAt: "2026-08-23T12:00:00Z",
        normalizedTargetKey: "example.com",
      }),
    ).toMatchObject({ id: jobId, status: "queued" });
    expect(
      outboxEventSchema.parse({
        id: jobId,
        accountId,
        eventKey: "assessment:1",
        aggregateType: "job",
        aggregateId: jobId,
        schemaVersion: "job.event@1",
        status: "pending",
        attempts: 0,
        maxAttempts: 5,
        availableAt: "2026-08-23T12:00:00Z",
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: 0,
        heartbeatAt: null,
        lastError: null,
        failedAt: null,
        processedAt: null,
        createdAt: "2026-08-23T12:00:00Z",
      }),
    ).toMatchObject({ eventKey: "assessment:1", status: "pending" });
  });
});
