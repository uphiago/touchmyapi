import { describe, expect, it } from "vitest";
import { createPostgresAuthStore, type PostgresAuthOperations } from "../src/postgres-auth-store";
import type { AuthDatabase, AuthSessionRecord } from "@touchmyapi/db";

const database = Object.freeze({}) as AuthDatabase;
const record: AuthSessionRecord = {
  userId: "00000000-0000-4000-8000-000000000201",
  accountId: "00000000-0000-4000-8000-000000000101",
  sessionId: "00000000-0000-4000-8000-000000000301",
  email: "owner@example.test",
  role: "owner",
  membershipStatus: "active",
  plan: "free_unverified",
  iaEnabled: true,
};

describe("PostgreSQL auth store adapter", () => {
  it("maps provider login and session operations without exposing hashes", async () => {
    const completed: unknown[] = [];
    const operations = {
      completeProviderLogin: async (_database, input) => {
        completed.push(input);
        return record;
      },
      resolveAuthSession: async () => record,
      rotateAuthSession: async () => record,
      revokeAuthSession: async () => true,
      listSessionAccounts: async () => [],
      switchAuthAccount: async () => record,
      acceptAuthInvitation: async () => ({ session: record, rotated: true }),
    } satisfies PostgresAuthOperations;
    const store = createPostgresAuthStore(database, operations);
    const input = {
      provider: "github" as const,
      providerSubject: "12345",
      email: "owner@example.test",
      sessionHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 3_600_000),
    };

    expect(await store.completeProviderLogin?.(input)).toMatchObject({
      userId: record.userId,
      accountId: record.accountId,
      email: record.email,
      role: record.role,
    });
    expect(completed).toEqual([input]);
    expect(await store.resolveSession("b".repeat(64))).not.toHaveProperty("sessionHash");
    expect(await store.revokeSession("c".repeat(64))).toBeUndefined();
  });

  it("keeps the Google compatibility call on the provider-neutral operation", async () => {
    const providers: string[] = [];
    const operations = {
      completeProviderLogin: async (_database, input) => {
        providers.push(input.provider);
        return record;
      },
      resolveAuthSession: async () => undefined,
      rotateAuthSession: async () => undefined,
      revokeAuthSession: async () => false,
      listSessionAccounts: async () => [],
      switchAuthAccount: async () => undefined,
      acceptAuthInvitation: async () => undefined,
    } satisfies PostgresAuthOperations;
    const store = createPostgresAuthStore(database, operations);

    await store.completeGoogleLogin({
      providerSubject: "google-subject",
      email: "owner@example.test",
      sessionHash: "d".repeat(64),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(providers).toEqual(["google"]);
  });
});
