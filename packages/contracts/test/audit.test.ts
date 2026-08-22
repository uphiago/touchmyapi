import { describe, expect, it } from "vitest";
import { auditEventSchema } from "../src/audit";

const auditEvent = {
  schemaVersion: "audit@1",
  id: "123e4567-e89b-12d3-a456-426614174003",
  prevId: null,
  actor: { kind: "user", id: "user_123" },
  action: "publish",
  subject: { assessmentId: "123e4567-e89b-12d3-a456-426614174001", jobId: null },
  payload: { assessmentStatus: "completed" },
  createdAt: "2026-08-17T12:11:00Z",
};

describe("audit event contract", () => {
  it("accepts a redacted chained audit event", () => {
    expect(auditEventSchema.parse(auditEvent)).toEqual(auditEvent);
  });

  it("rejects invalid action values, malformed subject ids, and secrets in payload", () => {
    expect(() => auditEventSchema.parse({ ...auditEvent, action: "mutate" })).toThrow();
    expect(() =>
      auditEventSchema.parse({ ...auditEvent, subject: { assessmentId: "bad", jobId: null } }),
    ).toThrow();
    expect(() =>
      auditEventSchema.parse({ ...auditEvent, payload: { apiToken: "never-here" } }),
    ).toThrow();
  });
});
