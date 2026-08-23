import { playbookSchema, type Playbook } from "@touchmyapi/contracts";

/** The only published passive public-posture catalog in foundation phase 2. */
export const surfacePublicPosture: Readonly<Playbook> = playbookSchema.parse({
  schemaVersion: "playbook.schema@1",
  key: "surface-public-posture",
  version: "1.0.0",
  targetCategory: "surface",
  active: true,
  preconditions: [{ kind: "http_verification_required", when: "active_external" }],
  actions: [
    {
      id: "dns.records",
      type: "dns_lookup",
      allowedTargets: "scope",
      limit: { requests: 1, durationS: 30 },
    },
    {
      id: "tls.cert",
      type: "tls_probe",
      allowedTargets: "scope",
      limit: { requests: 1, durationS: 30 },
    },
    {
      id: "http.headers",
      type: "http_probe",
      allowedTargets: "scope",
      method: "GET",
      limit: { requests: 5, durationS: 30 },
    },
    {
      id: "robots.txt",
      type: "robots_fetch",
      allowedTargets: "scope",
      method: "GET",
      limit: { requests: 1, durationS: 30 },
    },
    {
      id: "sitemap.xml",
      type: "sitemap_fetch",
      allowedTargets: "scope",
      method: "GET",
      limit: { requests: 1, durationS: 30 },
    },
    {
      id: "endpoint.minimal",
      type: "endpoint_probe",
      allowedTargets: "scope",
      method: "GET",
      limit: { requests: 2, durationS: 60 },
    },
  ],
  limits: {
    maxDurationS: 300,
    maxConcurrency: 1,
    maxRatePerMin: 10,
    egress: { allow: ["scope_target"], blockDefaults: true },
    impactLevels: ["low"],
  },
  stopSignals: ["scope_escape", "rate_exceeded", "unauthorized_endpoint", "duration_exceeded"],
  evidence: { expected: ["http_headers_snapshot", "tls_cert_metadata"], format: "manifest" },
  severityPossible: ["info", "low"],
});
