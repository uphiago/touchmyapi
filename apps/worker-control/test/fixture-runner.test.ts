import { describe, expect, it } from "vitest";
import { createFixtureRunner } from "../src/fixture-runner";

const job = {
  accountId: "d0d5973a-12b8-4bec-8b76-692bd8e072dd",
  jobId: "71724aad-2914-4c36-8fd2-5fe279475206",
  assessmentId: "dc37099e-9928-4656-b47c-026380311a3a",
  playbookKey: "surface-public-posture",
  playbookVersion: "1.0.0",
  target: "https://example.com",
  scope: ["example.com"],
  limits: {},
  contract: {},
};

describe("local fixture runner", () => {
  it("is development-only, deterministic, and performs no target fetch", async () => {
    expect(() => createFixtureRunner("production")).toThrow(/development-only/i);
    const runner = createFixtureRunner("development", () => new Date("2026-08-24T12:00:00Z"));
    const first = await runner.execute(job, new AbortController().signal);
    const second = await runner.execute(job, new AbortController().signal);
    expect(second).toEqual(first);
    expect(first.cleanup).toEqual({ containerRemoved: true, tmpfsRemoved: true });
    expect(first.observations?.map((item) => item.actionId)).toEqual([
      "dns.records",
      "tls.cert",
      "http.headers",
      "robots.txt",
      "sitemap.xml",
      "endpoint.minimal",
    ]);
  });
});
