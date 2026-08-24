import {
  createAuthInvitation,
  listAuthMemberships,
  updateAuthMembership,
  type AuthDatabase,
} from "@touchmyapi/db";
import type { Invitation } from "@touchmyapi/contracts";
import type { MembershipOperationResult, MembershipStore } from "./memberships";

export type InvitationDelivery = (
  input: Readonly<{
    invitation: Invitation;
    token: string;
  }>,
) => Promise<void>;

function failure(): MembershipOperationResult<never> {
  return { ok: false, code: "membership_required" };
}

export function createPostgresMembershipStore(
  database: AuthDatabase,
  deliverInvitation?: InvitationDelivery,
): MembershipStore {
  return {
    listMemberships: async (input) => {
      const memberships = await listAuthMemberships(database, input);
      return memberships.length > 0 ? { ok: true, value: memberships } : failure();
    },
    createInvitation: async ({
      sessionHash,
      accountId,
      email,
      role,
      tokenHash,
      expiresAt,
      deliveryToken,
    }) => {
      if (!deliverInvitation) throw new Error("invitation delivery unavailable");
      const invitation = await createAuthInvitation(database, {
        sessionHash,
        accountId,
        email,
        role,
        tokenHash,
        expiresAt,
      });
      if (!invitation) return failure();
      await deliverInvitation({ invitation, token: deliveryToken });
      return { ok: true, value: invitation };
    },
    updateMembership: async ({ sessionHash, accountId, userId, role, status }) => {
      const before = await listAuthMemberships(database, { sessionHash, accountId });
      const target = before.find((membership) => membership.userId === userId);
      if (!target) return failure();
      const activeOwners = before.filter(
        (membership) => membership.role === "owner" && membership.status === "active",
      ).length;
      const removesLastOwner =
        target.role === "owner" &&
        target.status === "active" &&
        activeOwners <= 1 &&
        ((role !== undefined && role !== "owner") || (status !== undefined && status !== "active"));
      if (removesLastOwner) return { ok: false, code: "last_owner_protected" };
      const membership = await updateAuthMembership(database, {
        sessionHash,
        accountId,
        userId,
        ...(role === undefined ? {} : { role }),
        ...(status === undefined ? {} : { status }),
      });
      return membership ? { ok: true, value: membership } : failure();
    },
    removeMembership: async ({ sessionHash, accountId, userId }) => {
      const before = await listAuthMemberships(database, { sessionHash, accountId });
      const target = before.find((membership) => membership.userId === userId);
      if (!target) return failure();
      const activeOwners = before.filter(
        (membership) => membership.role === "owner" && membership.status === "active",
      ).length;
      if (target.role === "owner" && target.status === "active" && activeOwners <= 1) {
        return { ok: false, code: "last_owner_protected" };
      }
      const membership = await updateAuthMembership(database, {
        sessionHash,
        accountId,
        userId,
        status: "removed",
      });
      return membership ? { ok: true, value: membership } : failure();
    },
  };
}
