import { describe, expect, it } from "vitest";
import { isPlan, rightsForPlan, type Plan } from "../src/entitlement";

const expectedRights: Record<Plan, object> = {
  free_unverified: {
    visibility: "aggregate",
    playbookSlice: "passive",
    maxCredits: 1,
    reports: false,
    scheduling: false,
    history: false,
  },
  free_verified: {
    visibility: "masked",
    playbookSlice: "introductory",
    maxCredits: 1,
    reports: false,
    scheduling: false,
    history: false,
  },
  pro: {
    visibility: "detailed",
    playbookSlice: "full",
    maxCredits: 10,
    reports: true,
    scheduling: true,
    history: true,
  },
  lifetime: {
    visibility: "detailed",
    playbookSlice: "full",
    maxCredits: 10,
    reports: true,
    scheduling: true,
    history: true,
  },
};

describe("plan entitlements", () => {
  it.each(Object.entries(expectedRights) as [Plan, object][])(
    "returns the exact rights matrix for %s",
    (plan, rights) => {
      expect(rightsForPlan(plan)).toEqual(rights);
    },
  );

  it.each([null, undefined, "admin", 42, {}, [], true])(
    "rejects unknown runtime plan %j without granting rights",
    (value) => {
      expect(isPlan(value)).toBe(false);
      expect(() => rightsForPlan(value as Plan)).toThrow();
    },
  );

  it("returns deeply frozen rights that cannot alter later calls", () => {
    const rights = rightsForPlan("pro");
    expect(Object.isFrozen(rights)).toBe(true);
    expect(() => {
      (rights as { maxCredits: number }).maxCredits = 999;
    }).toThrow();
    expect(rightsForPlan("pro").maxCredits).toBe(10);
  });
});
