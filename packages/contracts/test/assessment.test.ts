import { describe, expect, it } from "vitest";
import { assessmentCreateSchema, assessmentStateSchema } from "../src/assessment";

describe("assessment state contract", () => {
  it("accepts every persisted state", () => {
    for (const state of [
      "draft",
      "awaiting_verification",
      "queued",
      "running",
      "analyzing",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(assessmentStateSchema.parse(state)).toBe(state);
    }
  });

  it("rejects unknown states", () => {
    expect(() => assessmentStateSchema.parse("executing")).toThrow();
  });

  it("normalizes a bounded assessment creation request", () => {
    expect(
      assessmentCreateSchema.parse({
        targetCategory: "surface",
        target: "  example.test  ",
      }),
    ).toEqual({
      targetCategory: "surface",
      target: "example.test",
      scope: [],
      playbookId: "surface-public-posture",
    });
  });
});
