import { describe, expect, it } from "vitest";
import {
  accountListResponseSchema,
  accountSwitchSchema,
  invitationAcceptSchema,
  invitationCreateSchema,
  invitationCreateResponseSchema,
  membershipErrorCodeSchema,
  membershipListResponseSchema,
  membershipMutationResponseSchema,
  membershipRoleSchema,
  membershipRoleUpdateSchema,
  membershipSchema,
  membershipStatusUpdateSchema,
  membershipStatusSchema,
  membershipUpdateSchema,
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
      email: "owner@example.test",
      role: "owner",
      status: "active",
      createdAt,
      updatedAt: createdAt,
      removedAt: null,
      invitedByUserId: null,
    });
    expect(membership.accountId).toBe(accountId);
    expect(membership.email).toBe("owner@example.test");
    expect(() => membershipSchema.parse({ ...membership, isOwner: true })).toThrow();
    expect(() => membershipSchema.parse({ ...membership, accountId: "not-a-uuid" })).toThrow();
  });

  it("keeps lifecycle request and response shapes strict", () => {
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
    expect(membershipListResponseSchema.parse({ memberships: [membership] })).toEqual({
      memberships: [membership],
    });
    expect(membershipMutationResponseSchema.parse({ membership })).toEqual({ membership });
    expect(membershipRoleUpdateSchema.parse({ role: "admin" })).toEqual({ role: "admin" });
    expect(membershipStatusUpdateSchema.parse({ status: "suspended" })).toEqual({
      status: "suspended",
    });
    expect(membershipUpdateSchema.parse({ role: "admin", status: "active" })).toEqual({
      role: "admin",
      status: "active",
    });
    expect(() => membershipUpdateSchema.parse({})).toThrow();
    expect(() => membershipRoleUpdateSchema.parse({ role: "owner", status: "active" })).toThrow();
    expect(() => membershipStatusUpdateSchema.parse({ status: "removed", extra: true })).toThrow();
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
    const record = {
      id: membershipId,
      accountId,
      email: invitation.email,
      proposedRole: invitation.role,
      status: "pending" as const,
      expiresAt: invitation.expiresAt,
      acceptedAt: null,
      createdAt,
      invitedByUserId: userId,
      acceptedByUserId: null,
    };
    expect(invitationCreateResponseSchema.parse({ invitation: record })).toEqual({
      invitation: record,
    });
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
        {
          accountId,
          displayName: "Authorized Labs",
          role: "owner",
          status: "active",
          active: true,
        },
        { accountId: userId, role: "viewer", status: "suspended", active: false },
      ],
    });
    expect(accounts.accounts).toHaveLength(2);
    expect(accounts.accounts[0]?.displayName).toBe("Authorized Labs");
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
