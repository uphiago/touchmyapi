import type { AccountSummary, Invitation, Membership } from "../../../packages/contracts/src";
import { createApp, noopAuditSink, type ApiDependencies } from "./app";
import { hashSessionToken, type AuthDependencies, type AuthSession, type AuthStore } from "./auth";
import { createConfig, type ApiConfig } from "./config";
import type {
  MembershipDependencies,
  MembershipOperationResult,
  MembershipStore,
} from "./memberships";
import { createLocalAssessmentStore, type AssessmentStore } from "./assessments";
import type { DeliveryStore } from "./delivery";

export const LOCAL_SESSION_TOKEN = "L".repeat(43);
const localAccountId = "00000000-0000-4000-8000-000000000101";
const secondAccountId = "00000000-0000-4000-8000-000000000102";
const localUserId = "00000000-0000-4000-8000-000000000103";
const adminAccountId = "00000000-0000-4000-8000-000000000107";
const viewerAccountId = "00000000-0000-4000-8000-000000000108";
const billingAccountId = "00000000-0000-4000-8000-000000000109";
const timestamp = "2026-08-23T12:00:00.000Z";

const localAccounts = [
  { accountId: localAccountId, displayName: "Authorized Labs", role: "owner" },
  { accountId: adminAccountId, displayName: "Team Administration", role: "admin" },
  { accountId: secondAccountId, displayName: "Assessment Operations", role: "operator" },
  { accountId: viewerAccountId, displayName: "Read-only Delivery", role: "viewer" },
  { accountId: billingAccountId, displayName: "Plan & Billing", role: "billing" },
] as const;

const localMembership: Membership = {
  id: "00000000-0000-4000-8000-000000000105",
  accountId: localAccountId,
  userId: localUserId,
  email: "local.owner@example.test",
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

const localTeam: readonly Membership[] = [
  localMembership,
  ...(["admin", "operator", "viewer", "billing"] as const).map((role, index) => ({
    ...localMembership,
    id: `00000000-0000-4000-8000-0000000001${10 + index}`,
    userId: `00000000-0000-4000-8000-0000000002${10 + index}`,
    email: `local.${role}@example.test`,
    role,
    invitedByUserId: localUserId,
  })),
];

function ok<T>(value: T): MembershipOperationResult<T> {
  return { ok: true, value };
}

function roleFor(accountId: string): (typeof localAccounts)[number]["role"] {
  return localAccounts.find((account) => account.accountId === accountId)?.role ?? "viewer";
}

function planFor(accountId: string): AuthSession["plan"] {
  if (accountId === localAccountId) return "lifetime";
  if (accountId === adminAccountId || accountId === billingAccountId) return "pro";
  if (accountId === secondAccountId) return "free_verified";
  return "free_unverified";
}

function sessionFor(accountId: string, role = roleFor(accountId)): AuthSession {
  return {
    userId: localUserId,
    accountId,
    email: "local.owner@example.test",
    role,
    membershipStatus: "active",
    plan: planFor(accountId),
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
    completeGoogleLogin: async () => sessionFor(activeAccountId),
    resolveSession: async (sessionHash) =>
      (await isLocalSession(sessionHash)) ? sessionFor(activeAccountId) : undefined,
    rotateSession: async ({ replacementSessionHash }) => {
      knownSessionHashes.add(replacementSessionHash);
      return sessionFor(activeAccountId);
    },
    revokeSession: async () => undefined,
    listAccounts: async (sessionHash): Promise<readonly AccountSummary[]> => {
      if (!(await isLocalSession(sessionHash))) return [];
      return localAccounts.map((account) => ({
        ...account,
        status: "active" as const,
        active: activeAccountId === account.accountId,
      }));
    },
    switchAccount: async ({ sessionHash, targetAccountId, replacementSessionHash }) => {
      if (!(await isLocalSession(sessionHash))) return undefined;
      if (!localAccounts.some((account) => account.accountId === targetAccountId)) return undefined;
      activeAccountId = targetAccountId;
      knownSessionHashes.add(replacementSessionHash);
      return sessionFor(activeAccountId);
    },
    acceptInvitation: async ({ sessionHash, replacementSessionHash }) => {
      if (!(await isLocalSession(sessionHash))) return undefined;
      knownSessionHashes.add(replacementSessionHash);
      return { session: sessionFor(activeAccountId), rotated: true };
    },
  };
}

function localMembershipStore(): MembershipStore {
  const memberships = new Map<string, Membership[]>([
    [localAccountId, [...localTeam]],
    [secondAccountId, [secondMembership]],
    [adminAccountId, [{ ...secondMembership, accountId: adminAccountId, role: "admin" }]],
    [viewerAccountId, [{ ...secondMembership, accountId: viewerAccountId, role: "viewer" }]],
    [billingAccountId, [{ ...secondMembership, accountId: billingAccountId, role: "billing" }]],
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
      const accountMemberships = memberships.get(accountId) ?? [];
      const current = accountMemberships.find((entry) => entry.userId === userId);
      if (!current) return { ok: false, code: "membership_required" };
      if (
        current.role === "owner" &&
        current.status === "active" &&
        ((role !== undefined && role !== "owner") ||
          (status !== undefined && status !== "active")) &&
        accountMemberships.filter((entry) => entry.role === "owner" && entry.status === "active")
          .length === 1
      ) {
        return { ok: false, code: "last_owner_protected" };
      }
      const updated = { ...current, ...(role ? { role } : {}), ...(status ? { status } : {}) };
      memberships.set(
        accountId,
        accountMemberships.map((entry) => (entry.userId === userId ? updated : entry)),
      );
      return ok(updated);
    },
    removeMembership: async ({ accountId, userId }) => {
      const accountMemberships = memberships.get(accountId) ?? [];
      const current = accountMemberships.find((entry) => entry.userId === userId);
      if (!current) return { ok: false, code: "membership_required" };
      if (
        current.role === "owner" &&
        current.status === "active" &&
        accountMemberships.filter((entry) => entry.role === "owner" && entry.status === "active")
          .length === 1
      ) {
        return { ok: false, code: "last_owner_protected" };
      }
      const removed = {
        ...current,
        status: "removed" as const,
        removedAt: new Date().toISOString(),
      };
      memberships.set(
        accountId,
        accountMemberships.map((entry) => (entry.userId === userId ? removed : entry)),
      );
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
  options: Readonly<{ assessmentStore?: AssessmentStore; deliveryStore?: DeliveryStore }> = {},
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
    assessment: {
      store: options.assessmentStore ?? createLocalAssessmentStore(),
      resolveSession: auth.store.resolveSession,
      allowInsecureCookies: true,
    },
    ...(options.deliveryStore
      ? {
          delivery: {
            store: options.deliveryStore,
            resolveSession: auth.store.resolveSession,
            allowInsecureCookies: true,
          },
        }
      : {}),
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
