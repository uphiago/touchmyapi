import { describe, expect, it } from "vitest";
import { orderFairTenants, selectFairTenant, type FairTenant } from "../src/fair-scheduler";

const tenant = (accountId: string, lastDispatchedAt: Date | null, queuedCount = 1): FairTenant => ({
  accountId,
  lastDispatchedAt,
  runningCount: 0,
  concurrencyLimit: 2,
  queuedCount,
});

describe("fair scheduler", () => {
  it("orders never-dispatched tenants before noisy tenants, then by account id", () => {
    const ordered = orderFairTenants([
      tenant("z-noisy", new Date("2026-01-01T00:00:00Z")),
      tenant("b-quiet", null),
      tenant("a-quiet", null),
    ]);
    expect(ordered.map((item) => item.accountId)).toEqual(["a-quiet", "b-quiet", "z-noisy"]);
  });

  it("skips saturated or empty tenants and fails closed at the global cap", () => {
    const saturated = { ...tenant("a", null), runningCount: 2 };
    const selected = selectFairTenant(
      [saturated, tenant("b", new Date("2026-01-01T00:00:00Z"))],
      0,
      2,
    );
    expect(selected?.accountId).toBe("b");
    expect(selectFairTenant([tenant("b", null)], 2, 2)).toBeNull();
    expect(selectFairTenant([tenant("c", null, 0)], 0, 2)).toBeNull();
  });
});
