import { describe, expect, it } from "vitest";
import {
  canMembershipCapability,
  evaluateMembership,
  lastOwnerDecision,
  type MembershipCapability,
} from "../src/membership";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const capabilities = (role: "owner" | "admin" | "operator" | "viewer" | "billing") =>
  evaluateMembership({ accountId: ACCOUNT_ID, userId: USER_ID, role, status: "active" });

describe("membership policy", () => {
  it.each([
    [
      "owner",
      [
        "account:read",
        "membership:manage",
        "assessment:read",
        "assessment:create",
        "assessment:cancel",
        "billing:read",
      ],
    ],
    [
      "admin",
      [
        "account:read",
        "membership:manage",
        "assessment:read",
        "assessment:create",
        "assessment:cancel",
        "billing:read",
      ],
    ],
    ["operator", ["account:read", "assessment:read", "assessment:create", "assessment:cancel"]],
    ["viewer", ["account:read", "assessment:read"]],
    ["billing", ["account:read", "billing:read", "billing:purchase"]],
  ] as const)("allows only the capabilities assigned to %s", (role, expected) => {
    const result = capabilities(role);
    expect(result.allowed).toBe(true);
    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(result.userId).toBe(USER_ID);
    expect(result.capabilities).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
    for (const capability of expected) {
      expect(canMembershipCapability(result, capability)).toBe(true);
    }
  });

  it.each(["suspended", "removed"] as const)("denies %s membership by default", (status) => {
    const result = evaluateMembership({
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      role: "owner",
      status,
    });
    expect(result.allowed).toBe(false);
    expect(result.capabilities).toEqual([]);
    expect(result.reason).toBe("membership_suspended");
  });

  it("denies unknown or mismatched identity input", () => {
    expect(() =>
      evaluateMembership({
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        role: "unknown" as never,
        status: "active",
      }),
    ).toThrow();
    expect(() =>
      evaluateMembership({
        accountId: "not-a-uuid",
        userId: USER_ID,
        role: "viewer",
        status: "active",
      }),
    ).toThrow();
  });

  it("keeps capability checks closed to unknown strings", () => {
    const result = capabilities("viewer");
    expect(canMembershipCapability(result, "membership:manage")).toBe(false);
    expect(canMembershipCapability(result, "unknown" as MembershipCapability)).toBe(false);
  });

  it("returns a transaction-layer decision for the last active owner", () => {
    expect(lastOwnerDecision({ currentRole: "owner", activeOwnerCount: 1 })).toEqual({
      allowed: false,
      reason: "last_owner_protected",
    });
    expect(lastOwnerDecision({ currentRole: "owner", activeOwnerCount: 2 })).toEqual({
      allowed: true,
      reason: "ok",
    });
    expect(lastOwnerDecision({ currentRole: "admin", activeOwnerCount: 1 })).toEqual({
      allowed: true,
      reason: "ok",
    });
  });
});
