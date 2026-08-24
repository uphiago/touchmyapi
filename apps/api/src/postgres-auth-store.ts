import {
  acceptAuthInvitation,
  completeProviderLogin,
  listSessionAccounts,
  resolveAuthSession,
  revokeAuthSession,
  rotateAuthSession,
  switchAuthAccount,
  type AuthDatabase,
  type AuthSessionRecord,
} from "@touchmyapi/db";
import type { AuthSession, AuthStore } from "./auth";

export type PostgresAuthOperations = Readonly<{
  completeProviderLogin: typeof completeProviderLogin;
  resolveAuthSession: typeof resolveAuthSession;
  rotateAuthSession: typeof rotateAuthSession;
  revokeAuthSession: typeof revokeAuthSession;
  listSessionAccounts: typeof listSessionAccounts;
  switchAuthAccount: typeof switchAuthAccount;
  acceptAuthInvitation: typeof acceptAuthInvitation;
}>;

const defaultOperations: PostgresAuthOperations = {
  completeProviderLogin,
  resolveAuthSession,
  rotateAuthSession,
  revokeAuthSession,
  listSessionAccounts,
  switchAuthAccount,
  acceptAuthInvitation,
};

function toSession(record: AuthSessionRecord | undefined): AuthSession | undefined {
  if (!record) return undefined;
  return Object.freeze({
    userId: record.userId,
    accountId: record.accountId,
    email: record.email,
    role: record.role,
    membershipStatus: record.membershipStatus,
    plan: record.plan,
    iaEnabled: record.iaEnabled,
  });
}

export function createPostgresAuthStore(
  database: AuthDatabase,
  operations: PostgresAuthOperations = defaultOperations,
): AuthStore {
  return Object.freeze({
    completeGoogleLogin: async (input) =>
      toSession(await operations.completeProviderLogin(database, { provider: "google", ...input })),
    completeProviderLogin: async (input) =>
      toSession(await operations.completeProviderLogin(database, input)),
    resolveSession: async (sessionHash) =>
      toSession(await operations.resolveAuthSession(database, sessionHash)),
    rotateSession: async (input) => toSession(await operations.rotateAuthSession(database, input)),
    revokeSession: async (sessionHash) => {
      await operations.revokeAuthSession(database, sessionHash);
    },
    listAccounts: (sessionHash) => operations.listSessionAccounts(database, sessionHash),
    switchAccount: async (input) => toSession(await operations.switchAuthAccount(database, input)),
    acceptInvitation: async (input) => {
      const acceptance = await operations.acceptAuthInvitation(database, input);
      if (!acceptance) return undefined;
      const session = toSession(acceptance.session);
      return session ? { session, rotated: acceptance.rotated } : undefined;
    },
  });
}
