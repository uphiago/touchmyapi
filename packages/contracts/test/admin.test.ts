import { describe, expect, it } from "vitest";
import {
  adminGrantApprovalSchema,
  adminGrantRequestSchema,
  adminQueueActionRequestSchema,
} from "../src";

const accountId = "00000000-0000-4000-8000-000000000101";

describe("admin control-plane contracts", () => {
  it("accepts only bounded, account-scoped grant requests", () => {
    expect(
      adminGrantRequestSchema.parse({
        accountId,
        capability: "queue.requeue",
        ticket: "OPS-1234",
        reason: "Recover one reviewed local job",
        ttlSeconds: 900,
      }),
    ).toBeTruthy();
    expect(() =>
      adminGrantRequestSchema.parse({
        accountId: "*",
        capability: "sql.execute",
        ticket: "x",
        reason: "dump secret credentials",
        ttlSeconds: 86_400,
      }),
    ).toThrow();
  });

  it("requires a distinct approver identity", () => {
    expect(
      adminGrantApprovalSchema.parse({ approverId: "local-approver", decision: "approved" }),
    ).toBeTruthy();
    expect(() =>
      adminGrantApprovalSchema.parse({ approverId: "", decision: "approved" }),
    ).toThrow();
  });

  it("limits queue actions and reaper batch size", () => {
    expect(
      adminQueueActionRequestSchema.parse({
        grantId: crypto.randomUUID(),
        accountId,
        action: "queue.reap",
        batchSize: 25,
      }),
    ).toBeTruthy();
    expect(() =>
      adminQueueActionRequestSchema.parse({
        grantId: crypto.randomUUID(),
        accountId,
        action: "queue.reap",
        batchSize: 101,
      }),
    ).toThrow();
    expect(() =>
      adminQueueActionRequestSchema.parse({
        grantId: crypto.randomUUID(),
        accountId,
        action: "runner.dispatch",
      }),
    ).toThrow();
  });
});
