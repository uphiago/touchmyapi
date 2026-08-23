import { describe, expect, it } from "vitest";
import {
  accountListResponseSchema,
  accountSwitchSchema,
  invitationAcceptSchema,
  invitationCreateSchema,
  membershipErrorCodeSchema,
  membershipRoleSchema,
  membershipSchema,
  membershipStatusSchema,
} from "../src/membership";

const accountId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const membershipId = "00000000-0000-4000-8000-000000000003";
const createdAt = "2026-08-23T12:00:00.000Z";

describe("membership contracts", () => {
  it("accepts only the frozen role and status sets", () => {
    expect(membershipRoleSchema.options).toEqual([
      "owner",
      "admin",
      "operator",
      "viewer",
      "billing",
    ]);
    expect(membershipStatusSchema.options).toEqual(["active", "suspended", "removed"]);
    expect(() => membershipRoleSchema.parse("member")).toThrow();
    expect(() => membershipStatusSchema.parse("pending")).toThrow();
  });

  it("validates a strict membership record and rejects unknown keys", () => {
    const membership = membershipSchema.parse({
      id: membershipId,
      accountId,
      userId,
      role: "owner",
      status: "active",
      createdAt,
      updatedAt: createdAt,
      removedAt: null,
      invitedByUserId: null,
    });
    expect(membership.accountId).toBe(accountId);
    expect(() => membershipSchema.parse({ ...membership, isOwner: true })).toThrow();
    expect(() => membershipSchema.parse({ ...membership, accountId: "not-a-uuid" })).toThrow();
  });

  it("keeps invitation creation account-bound and strict", () => {
    const invitation = invitationCreateSchema.parse({
      email: "person@example.test",
      role: "operator",
      expiresAt: "2026-08-29T12:00:00.000Z",
    });
    expect(invitation).toEqual({
      email: "person@example.test",
      role: "operator",
      expiresAt: "2026-08-29T12:00:00.000Z",
    });
    expect(() => invitationCreateSchema.parse({ ...invitation, accountId })).toThrow();
    expect(() => invitationCreateSchema.parse({ ...invitation, role: "member" })).toThrow();
    expect(() => invitationCreateSchema.parse({ ...invitation, email: "not-an-email" })).toThrow();
  });

  it("accepts only a redaction-bound bearer token body", () => {
    const accepted = invitationAcceptSchema.parse({ token: "A".repeat(43) });
    expect(accepted).toEqual({ token: "A".repeat(43) });
    expect(() => invitationAcceptSchema.parse({ token: "short" })).toThrow();
    expect(() => invitationAcceptSchema.parse({ token: "A".repeat(43), accountId })).toThrow();
    expect(() => invitationAcceptSchema.parse({})).toThrow();
  });

  it("binds account listing and switching to server-owned IDs", () => {
    const accounts = accountListResponseSchema.parse({
      accounts: [
        { accountId, role: "owner", status: "active", active: true },
        { accountId: userId, role: "viewer", status: "suspended", active: false },
      ],
    });
    expect(accounts.accounts).toHaveLength(2);
    expect(accountSwitchSchema.parse({ accountId })).toEqual({ accountId });
    expect(() => accountListResponseSchema.parse({ ...accounts, extra: true })).toThrow();
    expect(() => accountSwitchSchema.parse({ accountId, userId })).toThrow();
  });

  it("exposes only stable membership error codes", () => {
    for (const code of [
      "invalid_invitation",
      "membership_required",
      "membership_suspended",
      "active_account_required",
      "last_owner_protected",
    ]) {
      expect(membershipErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(() => membershipErrorCodeSchema.parse("account_not_found")).toThrow();
  });
});
