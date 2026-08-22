import { describe, expect, it } from "vitest";
import { reportExportSchema } from "../src/export";

const report = {
  schemaVersion: "report.json@1",
  assessmentId: "123e4567-e89b-12d3-a456-426614174001",
  generatedAt: "2026-08-17T12:10:00Z",
  plan: "pro",
  target: { hostname: "example.com" },
  scope: {
    inclusions: ["example.com/*"],
    exclusions: [],
    window: { start: "2026-08-17T12:00:00Z", end: "2026-08-17T12:05:00Z" },
  },
  playbook: { key: "surface-public-posture", version: "1.0.0" },
  methodology: ["Passive inspection"],
  limitations: ["Scope limits"],
  findings: [
    {
      id: "123e4567-e89b-12d3-a456-426614174002",
      title: "Missing security header",
      category: "http.headers",
      severity: "low",
      evidence: { hashes: ["abc123"] },
      reproduction: ["Inspect response headers"],
      impact: "low",
      remediation: "Set the header.",
    },
  ],
  credits: { consumed: 1, estimate: 1 },
};

describe("report export contract", () => {
  it("accepts a plan-gated report export", () => {
    expect(reportExportSchema.parse(report)).toEqual(report);
  });

  it("rejects unknown plans, malformed findings, and secret fields", () => {
    expect(() => reportExportSchema.parse({ ...report, plan: "enterprise" })).toThrow();
    expect(() =>
      reportExportSchema.parse({ ...report, findings: [{ ...report.findings[0], id: "bad" }] }),
    ).toThrow();
    expect(() => reportExportSchema.parse({ ...report, token: "never-here" })).toThrow();
  });
});
