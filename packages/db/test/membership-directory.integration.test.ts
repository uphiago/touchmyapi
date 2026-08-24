import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeAuthDatabase,
  completeProviderLogin,
  createAuthDatabase,
  createAuthInvitation,
  listAuthMemberships,
  updateAuthMembership,
  type AuthDatabase,
} from "../src";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const describeDb = RUN_DB_TESTS ? describe : describe.skip;
const prefix = "membership-directory-";
const hash = (value: string) => createHash("sha256").update(`${prefix}${value}`).digest("hex");

function ownerUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for membership directory tests");
  const parsed = new URL(value);
  if (parsed.hostname !== "127.0.0.1" || !parsed.pathname.endsWith("_test")) {
    throw new Error("Membership directory tests require a loopback *_test database");
  }
  return value;
}

function connectorUrl(value: string): string {
  const parsed = new URL(value);
  parsed.username = "auth_connector";
  parsed.password = "auth_connector_test";
  return parsed.toString();
}

describeDb("least-privilege membership directory", () => {
  let owner!: RawDbConnection;
  let auth!: AuthDatabase;
  let accountId = "";
  let userId = "";
  const sessionHash = hash(randomUUID());

  beforeAll(async () => {
    const databaseUrl = ownerUrl();
    owner = createRawDbConnection(databaseUrl);
    await owner.unsafe(`alter role auth_connector password 'auth_connector_test'`);
    auth = createAuthDatabase(connectorUrl(databaseUrl));
    const session = await completeProviderLogin(auth, {
      provider: "github",
      providerSubject: `${prefix}${randomUUID()}`,
      email: "directory-owner@example.test",
      sessionHash,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    accountId = session?.accountId ?? "";
    userId = session?.userId ?? "";
  });

  afterAll(async () => {
    if (auth) await closeAuthDatabase(auth);
    if (owner && accountId) {
      await owner.begin(async (tx) => {
        await tx`delete from public.account_invitation where account_id = ${accountId}`;
        await tx`delete from public.session where account_id = ${accountId}`;
        await tx`delete from public.audit_event where account_id = ${accountId}`;
        await tx`delete from public.audit_account_state where account_id = ${accountId}`;
        await tx`delete from public.account_membership where account_id = ${accountId}`;
        await tx`delete from public.queue_tenant_state where account_id = ${accountId}`;
        await tx`delete from public."user" where account_id = ${accountId}`;
        await tx`delete from public.account where id = ${accountId}`;
      });
    }
    await owner?.end();
  });

  it("lists redacted memberships and returns a redacted invitation snapshot", async () => {
    expect(await listAuthMemberships(auth, { sessionHash, accountId })).toEqual([
      expect.objectContaining({ accountId, userId, role: "owner", status: "active" }),
    ]);
    const invitation = await createAuthInvitation(auth, {
      sessionHash,
      accountId,
      email: "invitee@example.test",
      role: "operator",
      tokenHash: hash("invitation"),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(invitation).toMatchObject({
      accountId,
      email: "invitee@example.test",
      proposedRole: "operator",
      status: "pending",
      invitedByUserId: userId,
    });
    expect(invitation).not.toHaveProperty("tokenHash");
  });

  it("keeps last-owner demotion fail-closed", async () => {
    expect(
      await updateAuthMembership(auth, {
        sessionHash,
        accountId,
        userId,
        role: "viewer",
      }),
    ).toBeUndefined();
    expect((await listAuthMemberships(auth, { sessionHash, accountId }))[0]).toMatchObject({
      role: "owner",
      status: "active",
    });
  });
});
