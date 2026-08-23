import type { AccountSummary, Invitation, Membership } from "../../../packages/contracts/src";
import { createApp, noopAuditSink, type ApiDependencies } from "./app";
import { hashSessionToken, type AuthDependencies, type AuthSession, type AuthStore } from "./auth";
import { createConfig, type ApiConfig } from "./config";
import type {
  MembershipDependencies,
  MembershipOperationResult,
  MembershipStore,
} from "./memberships";

export const LOCAL_SESSION_TOKEN = "L".repeat(43);
const localAccountId = "00000000-0000-4000-8000-000000000101";
const secondAccountId = "00000000-0000-4000-8000-000000000102";
const localUserId = "00000000-0000-4000-8000-000000000103";
const timestamp = "2026-08-23T12:00:00.000Z";

const localMembership: Membership = {
  id: "00000000-0000-4000-8000-000000000105",
  accountId: localAccountId,
  userId: localUserId,
  role: "owner",
  status: "active",
  invitedByUserId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  removedAt: null,
};

const secondMembership: Membership = {
  ...localMembership,
  id: "00000000-0000-4000-8000-000000000106",
  accountId: secondAccountId,
  role: "operator",
};

function ok<T>(value: T): MembershipOperationResult<T> {
  return { ok: true, value };
}

function sessionFor(accountId: string, role: string): AuthSession {
  return {
    userId: localUserId,
    accountId,
    email: "local.owner@example.test",
    role,
    membershipStatus: "active",
    plan: "free_unverified",
    iaEnabled: true,
  };
}

function localAuthStore(): AuthStore {
  let activeAccountId = localAccountId;
  const knownSessionHashes = new Set<string>();

  async function isLocalSession(sessionHash: string): Promise<boolean> {
    const expected = await hashSessionToken(LOCAL_SESSION_TOKEN);
    knownSessionHashes.add(expected);
    return knownSessionHashes.has(sessionHash);
  }

  return {
    completeGoogleLogin: async () => sessionFor(activeAccountId, "owner"),
    resolveSession: async (sessionHash) =>
      (await isLocalSession(sessionHash))
        ? sessionFor(activeAccountId, activeAccountId === localAccountId ? "owner" : "operator")
        : undefined,
    rotateSession: async ({ replacementSessionHash }) => {
      knownSessionHashes.add(replacementSessionHash);
      return sessionFor(activeAccountId, activeAccountId === localAccountId ? "owner" : "operator");
    },
    revokeSession: async () => undefined,
    listAccounts: async (sessionHash): Promise<readonly AccountSummary[]> => {
      if (!(await isLocalSession(sessionHash))) return [];
      return [
        {
          accountId: localAccountId,
          role: "owner",
          status: "active",
          active: activeAccountId === localAccountId,
        },
        {
          accountId: secondAccountId,
          role: "operator",
          status: "active",
          active: activeAccountId === secondAccountId,
        },
      ];
    },
    switchAccount: async ({ sessionHash, targetAccountId, replacementSessionHash }) => {
      if (!(await isLocalSession(sessionHash))) return undefined;
      if (targetAccountId !== localAccountId && targetAccountId !== secondAccountId)
        return undefined;
      activeAccountId = targetAccountId;
      knownSessionHashes.add(replacementSessionHash);
      return sessionFor(activeAccountId, activeAccountId === localAccountId ? "owner" : "operator");
    },
    acceptInvitation: async ({ sessionHash, replacementSessionHash }) => {
      if (!(await isLocalSession(sessionHash))) return undefined;
      knownSessionHashes.add(replacementSessionHash);
      return { session: sessionFor(activeAccountId, "owner"), rotated: true };
    },
  };
}

function localMembershipStore(): MembershipStore {
  const memberships = new Map<string, Membership[]>([
    [localAccountId, [localMembership]],
    [secondAccountId, [secondMembership]],
  ]);
  return {
    listMemberships: async ({ accountId }) => ok(memberships.get(accountId) ?? []),
    createInvitation: async ({ accountId, email, role, expiresAt, audit }) => {
      const invitation: Invitation = {
        id: crypto.randomUUID(),
        accountId,
        email,
        proposedRole: role,
        status: "pending",
        expiresAt: expiresAt.toISOString(),
        acceptedAt: null,
        createdAt: new Date().toISOString(),
        invitedByUserId: audit.actorUserId,
        acceptedByUserId: null,
      };
      return ok(invitation);
    },
    updateMembership: async ({ accountId, userId, role, status }) => {
      const current = memberships.get(accountId)?.find((entry) => entry.userId === userId);
      if (!current) return { ok: false, code: "membership_required" };
      const updated = { ...current, ...(role ? { role } : {}), ...(status ? { status } : {}) };
      memberships.set(accountId, [updated]);
      return ok(updated);
    },
    removeMembership: async ({ accountId, userId }) => {
      const current = memberships.get(accountId)?.find((entry) => entry.userId === userId);
      if (!current) return { ok: false, code: "membership_required" };
      const removed = {
        ...current,
        status: "removed" as const,
        removedAt: new Date().toISOString(),
      };
      memberships.set(accountId, [removed]);
      return ok(removed);
    },
  };
}

export function createLocalDevelopmentApp(
  config: ApiConfig = createConfig({
    corsOrigin: "http://localhost:5173",
    environment: "development",
    port: 3000,
  }),
): ReturnType<typeof createApp> {
  const auth: AuthDependencies = {
    adapter: {
      clientId: "local-mock-client",
      redirectUri: "http://localhost:3000/api/v1/auth/callback",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      exchangeCode: async () => ({
        issuer: "https://accounts.google.com",
        audience: "local-mock-client",
        subject: "local-mock-subject",
        email: "local.owner@example.test",
        emailVerified: true,
        nonce: "local-mock-nonce",
      }),
    },
    store: localAuthStore(),
    transientKey: new Uint8Array(32).fill(7),
    sessionMaxAgeSeconds: 3600,
    transientMaxAgeSeconds: 600,
    successRedirect: "http://localhost:5173/",
    allowInsecureCookies: true,
  };
  const dependencies: ApiDependencies = {
    config,
    logger: { error: (message, context) => console.error(`[local-api] ${message}`, context) },
    auditSink: noopAuditSink,
    auth,
    membership: {
      store: localMembershipStore(),
      resolveSession: auth.store.resolveSession,
      allowInsecureCookies: true,
    } satisfies MembershipDependencies,
  };
  const api = createApp(dependencies);
  api.get("/api/v1/auth/local-session", (context) => {
    const response = context.json({ mode: "local-mock" });
    response.headers.append(
      "Set-Cookie",
      `tma-session=${LOCAL_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return response;
  });
  return api;
}
