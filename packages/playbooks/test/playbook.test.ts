import { describe, expect, it } from "vitest";
import { playbookSchema, slicePassive, surfacePublicPosture, type Playbook } from "../src";

const actionIds = [
  "dns.records",
  "tls.cert",
  "http.headers",
  "robots.txt",
  "sitemap.xml",
  "endpoint.minimal",
];

describe("surface public posture playbook", () => {
  it("exports the exact closed passive catalog", () => {
    expect(surfacePublicPosture).toMatchObject({
      schemaVersion: "playbook.schema@1",
      key: "surface-public-posture",
      version: "1.0.0",
      targetCategory: "surface",
      active: true,
      limits: {
        maxDurationS: 300,
        maxConcurrency: 1,
        maxRatePerMin: 10,
        egress: { allow: ["scope_target"], blockDefaults: true },
        impactLevels: ["low"],
      },
      stopSignals: ["scope_escape", "rate_exceeded", "unauthorized_endpoint", "duration_exceeded"],
      severityPossible: ["info", "low"],
    });
    expect(surfacePublicPosture.actions.map(({ id }) => id)).toEqual(actionIds);
    expect(
      surfacePublicPosture.actions.every(({ allowedTargets }) => allowedTargets === "scope"),
    ).toBe(true);
    expect(playbookSchema.parse(surfacePublicPosture)).toEqual(surfacePublicPosture);
  });

  it("returns an independent passive slice without changing limits", () => {
    const original = structuredClone(surfacePublicPosture);
    const sliced = slicePassive(surfacePublicPosture);

    expect(sliced).toEqual(surfacePublicPosture);
    expect(sliced).not.toBe(surfacePublicPosture);
    expect(sliced.actions).not.toBe(surfacePublicPosture.actions);
    expect(sliced.limits).not.toBe(surfacePublicPosture.limits);
    expect(sliced.limits).toEqual(original.limits);

    (sliced.actions as Array<{ id: string }>)[0]!.id = "mutated";
    expect(surfacePublicPosture.actions[0]!.id).toBe("dns.records");
  });

  it("rejects unknown fields, action types, targets, and action IDs", () => {
    expect(() => playbookSchema.parse({ ...surfacePublicPosture, unexpected: true })).toThrow();
    expect(() =>
      playbookSchema.parse({
        ...surfacePublicPosture,
        actions: [{ ...surfacePublicPosture.actions[0], type: "fuzz" }],
      }),
    ).toThrow();
    expect(() =>
      slicePassive({
        ...surfacePublicPosture,
        actions: [{ ...surfacePublicPosture.actions[0], allowedTargets: "internet" }],
      } as unknown as Playbook),
    ).toThrow();
    expect(() =>
      slicePassive({
        ...surfacePublicPosture,
        actions: [{ ...surfacePublicPosture.actions[0], id: "unknown.action" }],
      } as unknown as Playbook),
    ).toThrow();
  });

  it("does not expose execution or network behavior", async () => {
    const module = await import("../src");
    expect(module).not.toHaveProperty("execute");
    expect(module).not.toHaveProperty("fetch");
    expect(module).not.toHaveProperty("probe");
  });
});
