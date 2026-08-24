import { describe, expect, it } from "vitest";
import { validateReportPublicationKeys } from "../src/worker-delivery";

describe("worker report publication boundary", () => {
  it("accepts only report objects belonging to the current tenant assessment", () => {
    const accountId = "123e4567-e89b-12d3-a456-426614174010";
    const assessmentId = "123e4567-e89b-12d3-a456-426614174011";
    const reports = [
      {
        kind: "json" as const,
        objectKey: `reports/${accountId}/${assessmentId}/json`,
        contractVersion: "report.json@1",
      },
    ];

    expect(validateReportPublicationKeys(accountId, assessmentId, reports)).toEqual(reports);
    expect(() =>
      validateReportPublicationKeys(accountId, assessmentId, [
        { ...reports[0]!, objectKey: `reports/${crypto.randomUUID()}/${assessmentId}/json` },
      ]),
    ).toThrow("report object key does not belong to assessment");
  });
});
