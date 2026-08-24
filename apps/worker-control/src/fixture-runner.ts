import { artifactManifestSchema, type ArtifactManifest } from "@touchmyapi/contracts";
import type { ClaimedWorkerJob } from "@touchmyapi/db";

export type PassiveRunner = Readonly<{
  kind: "fixture" | "isolated";
  execute: (job: ClaimedWorkerJob, signal: AbortSignal) => Promise<ArtifactManifest>;
}>;

export function createFixtureRunner(
  environment: "development" | "test" | "production",
  now: () => Date = () => new Date(),
): PassiveRunner {
  if (environment !== "development" && environment !== "test") {
    throw new Error("fixture runner is development-only");
  }
  return Object.freeze({
    kind: "fixture" as const,
    execute: async (job: ClaimedWorkerJob, signal: AbortSignal) => {
      if (signal.aborted) throw new Error("runner execution aborted");
      const observedAt = now().toISOString();
      return artifactManifestSchema.parse({
        schemaVersion: "job.artifacts@1",
        jobId: job.jobId,
        finishedAt: observedAt,
        exit: { code: 0, signal: null },
        limitsUsed: { cpuS: 0.01, memMB: 8, durationS: 0.01 },
        artifacts: [],
        observations: [
          {
            actionId: "dns.records",
            kind: "dns_records",
            observedAt,
            data: { hasCaa: false, recordCount: 2, fixture: true },
          },
          {
            actionId: "tls.cert",
            kind: "tls_certificate",
            observedAt,
            data: { endpoint: job.target, valid: true, daysRemaining: 90, fixture: true },
          },
          {
            actionId: "http.headers",
            kind: "http_headers",
            observedAt,
            data: {
              endpoint: job.target,
              status: 200,
              strictTransportSecurity: false,
              contentSecurityPolicy: true,
              fixture: true,
            },
          },
          {
            actionId: "robots.txt",
            kind: "resource_presence",
            observedAt,
            data: { present: true, fixture: true },
          },
          {
            actionId: "sitemap.xml",
            kind: "resource_presence",
            observedAt,
            data: { present: true, fixture: true },
          },
          {
            actionId: "endpoint.minimal",
            kind: "resource_presence",
            observedAt,
            data: { checked: true, fixture: true },
          },
        ],
        output: { summary: "Deterministic local fixture; no target contact.", truncated: false },
        stopsTriggered: [],
        cleanup: { containerRemoved: true, tmpfsRemoved: true },
      });
    },
  });
}
