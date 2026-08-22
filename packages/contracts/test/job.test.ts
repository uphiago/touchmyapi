import { describe, expect, it } from "vitest";
import { artifactManifestSchema, jobSpecSchema } from "../src/job";

const job = {
  schemaVersion: "job.spec@1",
  jobId: "123e4567-e89b-12d3-a456-426614174000",
  assessmentId: "123e4567-e89b-12d3-a456-426614174001",
  playbook: { key: "surface-public-posture", version: "1.0.0" },
  target: { hostname: "example.com" },
  scope: {
    inclusions: ["example.com/*"],
    exclusions: ["mail.example.com"],
    window: { start: "2026-08-17T12:00:00Z", end: "2026-08-17T12:05:00Z" },
  },
  actions: ["http.headers"],
  limits: {
    maxDurationS: 300,
    maxConcurrency: 1,
    maxRatePerMin: 10,
    egress: { allow: ["scope_target"], blockDefaults: true },
  },
  capabilities: ["http_client", "dns_resolver", "tls_probe"],
  ttl: "2026-08-17T12:06:00Z",
  issuedAt: "2026-08-17T12:00:00Z",
  issuer: "worker-control",
  signature: { alg: "Ed25519", value: "base64" },
};

const manifest = {
  schemaVersion: "job.artifacts@1",
  jobId: job.jobId,
  finishedAt: "2026-08-17T12:05:02Z",
  exit: { code: 0, signal: null },
  limitsUsed: { cpuS: 12, memMB: 84, durationS: 62 },
  artifacts: [{ path: "evidence/snapshot.json", sha256: "abc123", size: 1284, kind: "json" }],
  output: { summary: "redacted", truncated: false },
  stopsTriggered: ["duration_exceeded"],
  cleanup: { containerRemoved: true, tmpfsRemoved: true },
};

describe("job contracts", () => {
  it("accepts a signed job and redacted artifact manifest", () => {
    expect(jobSpecSchema.parse(job)).toEqual(job);
    expect(artifactManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("rejects unknown capabilities, malformed dates, and credential fields", () => {
    expect(() => jobSpecSchema.parse({ ...job, capabilities: ["shell_exec"] })).toThrow();
    expect(() => jobSpecSchema.parse({ ...job, ttl: "tomorrow" })).toThrow();
    expect(() =>
      jobSpecSchema.parse({ ...job, credentials: { password: "never-here" } }),
    ).toThrow();
  });

  it("rejects raw runner output and invalid manifest types", () => {
    expect(() =>
      artifactManifestSchema.parse({ ...manifest, output: { raw: "unbounded" } }),
    ).toThrow();
    expect(() =>
      artifactManifestSchema.parse({ ...manifest, exit: { code: "0", signal: null } }),
    ).toThrow();
  });
});
