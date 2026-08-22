import { describe, expect, it } from "vitest";
import { playbookSchema } from "../src/playbook";

const playbook = {
  schemaVersion: "playbook.schema@1",
  key: "surface-public-posture",
  version: "1.0.0",
  targetCategory: "surface",
  active: true,
  preconditions: [{ kind: "http_verification_required", when: "active_external" }],
  actions: [
    {
      id: "http.headers",
      type: "http_probe",
      allowedTargets: "scope",
      method: "GET",
      limit: { requests: 5, durationS: 30 },
    },
  ],
  limits: {
    maxDurationS: 300,
    maxConcurrency: 1,
    maxRatePerMin: 10,
    egress: { allow: ["scope_target"], blockDefaults: true },
    impactLevels: ["low"],
  },
  stopSignals: ["scope_escape", "rate_exceeded"],
  evidence: { expected: ["http_headers_snapshot"], format: "manifest" },
  severityPossible: ["info", "low"],
};

describe("playbook contract", () => {
  it("accepts a valid versioned playbook", () => {
    expect(playbookSchema.parse(playbook)).toEqual(playbook);
  });

  it("rejects unapproved action types and stop signals", () => {
    expect(() =>
      playbookSchema.parse({ ...playbook, actions: [{ ...playbook.actions[0], type: "fuzz" }] }),
    ).toThrow();
    expect(() => playbookSchema.parse({ ...playbook, stopSignals: ["continue_anyway"] })).toThrow();
  });

  it("rejects unknown action fields", () => {
    expect(() =>
      playbookSchema.parse({
        ...playbook,
        actions: [{ ...playbook.actions[0], credentials: "never-here" }],
      }),
    ).toThrow();
  });
});
