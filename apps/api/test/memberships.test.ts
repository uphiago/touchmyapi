import { describe, expect, it } from "vitest";
import { createApp, type ApiDependencies } from "../src/app";
import { createConfig } from "../src/config";
import {
  hashSessionToken,
  type AuthSession,
  type GoogleIdentityClaims,
  type GoogleOidcAdapter,
  type AuthStore,
} from "../src/auth";
import type {
  MembershipDependencies,
  MembershipOperationResult,
  MembershipStore,
} from "../src/memberships";
import type { Invitation, Membership } from "@touchmyapi/contracts";

const accountId = "00000000-0000-4000-8000-000000000001";
const otherAccountId = "00000000-0000-4000-8000-000000000004";
const userId = "00000000-0000-4000-8000-000000000002";
const invitedUserId = "00000000-0000-4000-8000-000000000003";
const membershipId = "00000000-0000-4000-8000-000000000005";
const sessionToken = "S".repeat(43);
const sessionCookie = `__Secure-tma-session=${sessionToken}`;
const timestamp = "2026-08-23T12:00:00.000Z";

const session: AuthSession = {
  userId,
  accountId,
  email: "owner@example.test",
  role: "owner",
  membershipStatus: "active",
  plan: "free_unverified",
  iaEnabled: true,
};

const membership: Membership = {
  id: membershipId,
  accountId,
  userId: invitedUserId,
  role: "viewer",
  status: "active",
  invitedByUserId: userId,
  createdAt: timestamp,
  updatedAt: timestamp,
  removedAt: null,
};

const invitation: Invitation = {
  id: "00000000-0000-4000-8000-000000000006",
  accountId,
  email: "new@example.test",
  proposedRole: "operator",
  status: "pending",
  expiresAt: "2026-08-30T12:00:00.000Z",
  acceptedAt: null,
  createdAt: timestamp,
  invitedByUserId: userId,
  acceptedByUserId: null,
};

const adapter: GoogleOidcAdapter = {
  clientId: "google-client-id",
  redirectUri: "https://api.example.test/api/v1/auth/callback",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  exchangeCode: async () => {
    const claims: GoogleIdentityClaims = {
      issuer: "https://accounts.google.com",
      audience: "google-client-id",
      subject: "subject",
      email: "owner@example.test",
      emailVerified: true,
      nonce: "nonce",
    };
    return claims;
  },
};

function ok<T>(value: T): MembershipOperationResult<T> {
  return { ok: true, value };
}

function error(code: "membership_required" | "membership_suspended" | "last_owner_protected") {
  return { ok: false as const, code };
}

function createFixture(overrides: Partial<MembershipStore> = {}) {
  const calls: {
    list?: Parameters<MembershipStore["listMemberships"]>[0];
    create?: Parameters<MembershipStore["createInvitation"]>[0];
    updates: Array<Parameters<MembershipStore["updateMembership"]>[0]>;
    removals: Array<Parameters<MembershipStore["removeMembership"]>[0]>;
  } = { updates: [], removals: [] };
  const sessionHashPromise = hashSessionToken(sessionToken);
  const store: MembershipStore = {
    listMemberships: async (input) => {
      calls.list = input;
      return ok([membership]);
    },
    createInvitation: async (input) => {
      calls.create = input;
      return ok(invitation);
    },
    updateMembership: async (input) => {
      calls.updates.push(input);
      return ok({
        ...membership,
        ...(input.role ? { role: input.role } : {}),
        ...(input.status ? { status: input.status } : {}),
      });
    },
    removeMembership: async (input) => {
      calls.removals.push(input);
      return ok({ ...membership, status: "removed" });
    },
    ...overrides,
  };
  const authStore: AuthStore = {
    completeGoogleLogin: async () => session,
    resolveSession: async (hash) => ((await sessionHashPromise) === hash ? session : undefined),
    rotateSession: async () => session,
    revokeSession: async () => undefined,
  };
  const membershipDependencies: MembershipDependencies = {
    store,
    resolveSession: authStore.resolveSession,
  };
  const dependencies: ApiDependencies = {
    config: createConfig({
      corsOrigin: "https://console.example.test",
      environment: "test",
      port: 3100,
    }),
    logger: { error: () => undefined },
    auditSink: { record: async () => undefined },
    auth: {
      adapter,
      store: authStore,
      transientKey: new Uint8Array(32).fill(1),
      sessionMaxAgeSeconds: 3600,
      transientMaxAgeSeconds: 600,
      successRedirect: "https://console.example.test/",
    },
    membership: membershipDependencies,
  };
  return { app: createApp(dependencies), calls };
}

describe("membership lifecycle API", () => {
  it("lists memberships only for the active server session account", async () => {
    const fixture = createFixture();
    const response = await fixture.app.request(
      `http://localhost/api/v1/accounts/${accountId}/memberships`,
      { headers: { Cookie: sessionCookie, Origin: "https://console.example.test" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ memberships: [membership] });
    expect(fixture.calls.list?.accountId).toBe(accountId);
    expect(fixture.calls.list?.sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://console.example.test",
    );
  });

  it("rejects a URL account that differs from the active session before store access", async () => {
    const fixture = createFixture();
    const response = await fixture.app.request(
      `http://localhost/api/v1/accounts/${otherAccountId}/memberships`,
      { headers: { Cookie: sessionCookie } },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "active_account_required", message: "Active account required" },
    });
    expect(fixture.calls.list).toBeUndefined();
  });

  it("creates hash-only invitations and delivers the raw token only to the injected adapter", async () => {
    const fixture = createFixture();
    const response = await fixture.app.request(
      `http://localhost/api/v1/accounts/${accountId}/memberships/invitations`,
      {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "new@example.test",
          role: "operator",
          expiresAt: "2026-08-30T12:00:00.000Z",
        }),
      },
    );

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload).toEqual({ invitation });
    expect(fixture.calls.create?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.calls.create?.deliveryToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fixture.calls.create?.deliveryToken).not.toBe(fixture.calls.create?.tokenHash);
    expect(fixture.calls.create?.audit).toEqual({
      accountId,
      actorUserId: userId,
      action: "membership.invitation_created",
    });
    expect(JSON.stringify(payload)).not.toContain(fixture.calls.create?.deliveryToken ?? "");
  });

  it("maps role, status, and remove mutations to the store with server-bound IDs", async () => {
    const fixture = createFixture();
    const roleResponse = await fixture.app.request(
      `http://localhost/api/v1/accounts/${accountId}/memberships/${invitedUserId}`,
      {
        method: "PATCH",
        headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
    );
    const statusResponse = await fixture.app.request(
      `http://localhost/api/v1/accounts/${accountId}/memberships/${invitedUserId}`,
      {
        method: "PATCH",
        headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "suspended" }),
      },
    );
    const removeResponse = await fixture.app.request(
      `http://localhost/api/v1/accounts/${accountId}/memberships/${invitedUserId}`,
      { method: "DELETE", headers: { Cookie: sessionCookie } },
    );

    expect(roleResponse.status).toBe(200);
    expect(statusResponse.status).toBe(200);
    expect(removeResponse.status).toBe(200);
    expect(fixture.calls.updates).toEqual([
      expect.objectContaining({ accountId, userId: invitedUserId, role: "admin" }),
      expect.objectContaining({ accountId, userId: invitedUserId, status: "suspended" }),
    ]);
    expect(fixture.calls.removals).toEqual([
      expect.objectContaining({ accountId, userId: invitedUserId }),
    ]);
    expect(fixture.calls.updates[0]?.audit.action).toBe("membership.updated");
    expect(fixture.calls.updates[1]?.audit.action).toBe("membership.updated");
    expect(fixture.calls.removals[0]?.audit.action).toBe("membership.removed");
  });

  it("preserves stable policy failures such as suspension and last-owner protection", async () => {
    const fixture = createFixture({
      updateMembership: async () => error("last_owner_protected"),
    });
    const response = await fixture.app.request(
      `http://localhost/api/v1/accounts/${accountId}/memberships/${invitedUserId}`,
      {
        method: "PATCH",
        headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "last_owner_protected",
        message: "The last active owner cannot be removed or demoted",
      },
    });
  });
});
