import { describe, expect, it } from "vitest";
import {
  artifactManifestSchema,
  assessmentDeliveryResponseSchema,
  notificationListResponseSchema,
  reportListResponseSchema,
  reportDownloadResponseSchema,
} from "../../packages/contracts/src";

const assessmentId = "8f34299a-ee29-4b91-809d-e66ae830d165";
const findingId = "4d2d511f-e754-4db4-ac3d-78ec6164061a";

describe("customer delivery contracts", () => {
  it("accepts a masked finding delivery without restricted detail", () => {
    const response = assessmentDeliveryResponseSchema.parse({
      assessmentId,
      status: "completed",
      visibility: "masked",
      summary: { total: 1, bySeverity: { low: 1 }, byCategory: { transport: 1 } },
      findings: [
        {
          id: findingId,
          title: "Transport policy can be strengthened",
          category: "transport",
          severity: "low",
        },
      ],
    });

    expect(response.findings).toHaveLength(1);
    expect(response.findings[0]).not.toHaveProperty("evidence");
  });

  it("rejects a secret-bearing detailed finding at the public boundary", () => {
    expect(() =>
      assessmentDeliveryResponseSchema.parse({
        assessmentId,
        status: "completed",
        visibility: "detailed",
        summary: { total: 1, bySeverity: { low: 1 }, byCategory: { headers: 1 } },
        findings: [
          {
            id: findingId,
            title: "Header result",
            category: "headers",
            severity: "low",
            endpoint: "https://example.com/",
            evidence: { authorization: "Bearer must-not-leak" },
            reproduction: ["GET /"],
            impact: "Defense in depth is reduced.",
            remediation: "Add the header.",
          },
        ],
      }),
    ).toThrow(/Secret-bearing/i);
  });

  it("keeps notifications and report metadata strict and secret-free", () => {
    expect(
      notificationListResponseSchema.parse({
        notifications: [
          {
            id: "8470508f-78ca-4930-a934-4639d2648f73",
            assessmentId,
            kind: "assessment_completed",
            readAt: null,
            createdAt: "2026-08-24T12:00:00.000Z",
          },
        ],
        unreadCount: 1,
      }).unreadCount,
    ).toBe(1);

    expect(
      reportListResponseSchema.parse({
        reports: [
          {
            id: "14257e38-364d-4a80-851b-e9fdc7bfd602",
            assessmentId,
            kind: "json",
            contractVersion: "report.json@1",
            generatedAt: "2026-08-24T12:00:00.000Z",
          },
        ],
      }).reports[0],
    ).not.toHaveProperty("objectKey");
  });

  it("accepts only expiring HTTP(S) report download locations", () => {
    expect(
      reportDownloadResponseSchema.parse({
        url: "https://private-storage.example.test/report?X-Amz-Expires=60",
        expiresAt: "2026-08-24T12:01:00.000Z",
      }).url,
    ).toContain("X-Amz-Expires=60");
    expect(() =>
      reportDownloadResponseSchema.parse({
        url: "memory://private-report",
        expiresAt: "2026-08-24T12:01:00.000Z",
      }),
    ).toThrow();
  });

  it("accepts only bounded, redacted passive observations from a runner", () => {
    const manifest = artifactManifestSchema.parse({
      schemaVersion: "job.artifacts@1",
      jobId: "5b68f1de-3cb3-4d59-9ca6-8915dc1054c2",
      finishedAt: "2026-08-24T12:00:00.000Z",
      exit: { code: 0, signal: null },
      limitsUsed: { cpuS: 0.1, memMB: 16, durationS: 1.4 },
      artifacts: [],
      observations: [
        {
          actionId: "http.headers",
          kind: "http_headers",
          observedAt: "2026-08-24T11:59:59.000Z",
          data: { status: 200, strictTransportSecurity: false },
        },
      ],
      stopsTriggered: [],
      cleanup: { containerRemoved: true, tmpfsRemoved: true },
    });
    expect(manifest.observations).toHaveLength(1);

    expect(() =>
      artifactManifestSchema.parse({
        ...manifest,
        observations: [
          {
            actionId: "http.headers",
            kind: "http_headers",
            observedAt: "2026-08-24T11:59:59.000Z",
            data: { cookie: "session=must-not-leak" },
          },
        ],
      }),
    ).toThrow(/Secret-bearing/i);
  });
});
