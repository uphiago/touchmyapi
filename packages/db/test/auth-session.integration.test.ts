import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAuthDatabase,
  completeProviderLogin,
  createAuthDatabase,
  listSessionAccounts,
  resolveAuthSession,
  revokeAuthSession,
  rotateAuthSession,
  type AuthDatabase,
} from "../src";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const describeDb = RUN_DB_TESTS ? describe : describe.skip;
const subjectPrefix = "auth-session-integration-";
const hash = (value: string) =>
  createHash("sha256").update(`${subjectPrefix}${value}`).digest("hex");

function ownerDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for auth session tests");
  const parsed = new URL(value);
  if (!/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) || !parsed.pathname.endsWith("_test")) {
    throw new Error("Auth session tests require a loopback *_test database");
  }
  return value;
}

function connectorDatabaseUrl(ownerUrl: string): string {
  const parsed = new URL(ownerUrl);
  parsed.username = "auth_connector";
  parsed.password = "auth_connector_test";
  return parsed.toString();
}

async function cleanup(owner: RawDbConnection): Promise<void> {
  const users = await owner`
    select id, account_id from public."user"
    where provider_subject like ${`${subjectPrefix}%`}
  `;
  for (const user of users) {
    await owner.begin(async (tx) => {
      await tx`delete from public.session where user_id = ${user.id}`;
      await tx`delete from public.audit_event where account_id = ${user.account_id}`;
      await tx`delete from public.audit_account_state where account_id = ${user.account_id}`;
      await tx`delete from public.account_membership where user_id = ${user.id}`;
      await tx`delete from public.queue_tenant_state where account_id = ${user.account_id}`;
      await tx`delete from public."user" where id = ${user.id}`;
      await tx`delete from public.account where id = ${user.account_id}`;
    });
  }
}

describeDb("least-privilege auth session database", () => {
  let owner!: RawDbConnection;
  let auth!: AuthDatabase;

  beforeAll(async () => {
    const ownerUrl = ownerDatabaseUrl();
    owner = createRawDbConnection(ownerUrl);
    await owner.unsafe(`alter role auth_connector password 'auth_connector_test'`);
    await cleanup(owner);
    auth = createAuthDatabase(connectorDatabaseUrl(ownerUrl));
  });

  afterAll(async () => {
    if (owner) await cleanup(owner);
    if (auth) await closeAuthDatabase(auth);
    await owner?.end();
  });

  it("creates, resolves, rotates, lists, and revokes a sanitized session", async () => {
    const firstHash = hash(randomUUID());
    const replacementHash = hash(randomUUID());
    const created = await completeProviderLogin(auth, {
      provider: "github",
      providerSubject: `${subjectPrefix}owner`,
      email: "owner@example.test",
      sessionHash: firstHash,
      expiresAt: new Date(Date.now() + 3_600_000),
      ip: "127.0.0.1",
      userAgent: "auth-session-integration",
    });

    expect(created).toMatchObject({
      accountId: expect.any(String),
      userId: expect.any(String),
      email: "owner@example.test",
      role: "owner",
      membershipStatus: "active",
      plan: "free_unverified",
      iaEnabled: true,
    });
    expect(created).not.toHaveProperty("sessionHash");
    expect(await resolveAuthSession(auth, firstHash)).toEqual(created);
    expect(await listSessionAccounts(auth, firstHash)).toEqual([
      { accountId: created?.accountId, role: "owner", status: "active", active: true },
    ]);

    expect(
      await rotateAuthSession(auth, {
        currentSessionHash: firstHash,
        replacementSessionHash: replacementHash,
        replacementExpiresAt: new Date(Date.now() + 3_600_000),
      }),
    ).toMatchObject({ userId: created?.userId, accountId: created?.accountId });
    expect(await resolveAuthSession(auth, firstHash)).toBeUndefined();
    expect(await revokeAuthSession(auth, replacementHash)).toBe(true);
    expect(await resolveAuthSession(auth, replacementHash)).toBeUndefined();
  });

  it("rejects a database-owner connection instead of silently widening auth", async () => {
    const unsafe = createAuthDatabase(ownerDatabaseUrl());
    await expect(resolveAuthSession(unsafe, hash("owner-rejected"))).rejects.toThrow(
      "auth connection rejected",
    );
    await closeAuthDatabase(unsafe);
  });
});
