import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { membershipRole, membershipStatus, invitationStatus } from "../schema/membership";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

function databaseUrlForIntegration(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for membership schema tests");
  const parsed = new URL(value);
  if (
    !parsed.hostname.match(/^(127\.0\.0\.1|localhost)$/u) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Membership schema tests require a loopback *_test database");
  }
  return value;
}

describeDb("Phase 2A membership schema", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForIntegration());
  });

  afterAll(async () => {
    await db?.end();
  });

  beforeAll(async () => {
    await db`
      insert into account (id) values
        ('00000000-0000-4000-8000-000000000101'),
        ('00000000-0000-4000-8000-000000000102')
      on conflict (id) do nothing
    `;
    await db`
      insert into public."user" (id, account_id, provider, provider_subject, email) values
        ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'google', 'membership-schema-user-a', 'schema-a@example.test'),
        ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000102', 'google', 'membership-schema-user-b', 'schema-b@example.test')
      on conflict (id) do nothing
    `;
  });

  it("creates membership and invitation tables without a second identity table", async () => {
    const tables = await db`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('account_membership', 'account_invitation', 'user_identity', 'identity')
      order by table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual([
      "account_invitation",
      "account_membership",
    ]);

    const invitationColumns = await db`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'account_invitation'
      order by ordinal_position
    `;
    expect(invitationColumns.map((row) => row.column_name)).not.toContain("token");
    expect(invitationColumns.map((row) => row.column_name)).toContain("token_hash");
  });

  it("enforces tenant membership references and one membership per account/user", async () => {
    const constraints = await db`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid in ('public.account_membership'::regclass, 'public.account_invitation'::regclass)
      order by conname
    `;
    const definitions = constraints.map((row) => `${row.conname}: ${row.definition}`);
    expect(definitions.join("\n")).toMatch(/account_membership_account_user_unique/i);
    expect(definitions.join("\n")).toMatch(/account_membership_account_fk/i);
    expect(definitions.join("\n")).toMatch(/account_membership_user_fk/i);
    expect(definitions.join("\n")).toMatch(/account_invitation_token_hash_unique/i);

    const identityForeignKeys = await db`
      select
        c.conname,
        pg_get_constraintdef(c.oid) as definition
      from pg_constraint as c
      where c.conrelid in ('public.account_membership'::regclass, 'public.account_invitation'::regclass)
        and c.contype = 'f'
        and c.conname in (
          'account_membership_user_fk',
          'account_membership_invited_by_user_fk',
          'account_invitation_invited_by_user_fk',
          'account_invitation_accepted_by_user_fk'
        )
      order by c.conname
    `;
    expect(identityForeignKeys).toHaveLength(4);
    for (const row of identityForeignKeys) {
      expect(row.definition).toMatch(
        /FOREIGN KEY \([^,()]+\) REFERENCES (?:["']?public["']?\.)?["']?user["']?\(id\)/i,
      );
      expect(row.definition).not.toMatch(/account_id/i);
    }
  });

  it("enables forced tenant RLS with no public fallback", async () => {
    const tables = await db`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class as c
      where c.oid in ('public.account_membership'::regclass, 'public.account_invitation'::regclass)
      order by c.relname
    `;
    expect(tables).toEqual([
      { relname: "account_invitation", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "account_membership", relrowsecurity: true, relforcerowsecurity: true },
    ]);

    const policies = await db`
      select polname, polroles::regrole[] as roles
      from pg_policy
      where polrelid in ('public.account_membership'::regclass, 'public.account_invitation'::regclass)
      order by polname
    `;
    expect(policies.map((row) => row.polname)).toEqual([
      "account_invitation_api_rls_tenant",
      "account_invitation_reporting_rls_tenant",
      "account_invitation_worker_rls_tenant",
      "account_membership_api_rls_tenant",
      "account_membership_bootstrap",
      "account_membership_reporting_rls_tenant",
      "account_membership_worker_rls_tenant",
    ]);
  });

  it("keeps legacy user ownership columns and closed membership enum values", async () => {
    const columns = await db`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'user'
        and column_name in ('account_id', 'provider_subject')
      order by column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual(["account_id", "provider_subject"]);
    const unique = await db`
      select conname
      from pg_constraint
      where conrelid = 'public.user'::regclass and contype = 'u'
    `;
    expect(unique.map((row) => row.conname)).toContain("user_account_id_unique");

    expect(membershipRole.enumValues).toEqual(["owner", "admin", "operator", "viewer", "billing"]);
    expect(membershipStatus.enumValues).toEqual(["active", "suspended", "removed"]);
    expect(invitationStatus.enumValues).toEqual(["pending", "accepted", "expired", "revoked"]);
  });

  it("allows multiple active owners while storing no raw invitation token", async () => {
    const accountA = { id: "00000000-0000-4000-8000-000000000101" };
    const userAId = "00000000-0000-4000-8000-000000000201";
    const userBId = "00000000-0000-4000-8000-000000000202";
    const membershipA = crypto.randomUUID();
    const membershipB = crypto.randomUUID();
    await db.begin(async (transaction) => {
      await transaction`
        delete from account_invitation
        where account_id = ${accountA.id} and invited_by_user_id = ${userAId}
      `;
      await transaction`
        delete from account_membership
        where account_id = ${accountA.id} and user_id in (${userAId}, ${userBId})
      `;
      await transaction`
        insert into account_membership (id, account_id, user_id, role, status)
        values
          (${membershipA}, ${accountA.id}, ${userAId}, 'owner', 'active'),
          (${membershipB}, ${accountA.id}, ${userBId}, 'owner', 'active')
      `;
      await transaction`
        insert into account_invitation
          (id, account_id, token_hash, email, proposed_role, status, expires_at, invited_by_user_id)
        values
          (${crypto.randomUUID()}, ${accountA.id}, ${"a".repeat(64)}, 'invitee@example.test',
           'viewer', 'pending', now() + interval '1 day', ${userAId})
      `;
    });
    const [owners] = await db`
      select count(*)::int as count
      from account_membership
      where account_id = ${accountA.id} and role = 'owner' and status = 'active'
    `;
    expect(owners?.count).toBe(2);
    const [rawToken] = await db`
      select token_hash, to_jsonb(account_invitation) ? 'token' as has_raw_token
      from account_invitation where token_hash = ${"a".repeat(64)}
    `;
    expect(rawToken?.token_hash).toBe("a".repeat(64));
    expect(rawToken?.has_raw_token).toBe(false);
  });

  it("lists memberships and atomically switches the active session account", async () => {
    const accountA = "00000000-0000-4000-8000-000000000101";
    const accountB = "00000000-0000-4000-8000-000000000102";
    const userA = "00000000-0000-4000-8000-000000000201";
    const sessionId = crypto.randomUUID();
    const oldHash = "b".repeat(64);
    const newHash = "c".repeat(64);
    await db.begin(async (transaction) => {
      await transaction`delete from public.session where user_id = ${userA}`;
      await transaction`
        insert into account_membership (account_id, user_id, role, status)
        values (${accountB}, ${userA}, 'viewer', 'active')
        on conflict (account_id, user_id) do update set status = 'active'
      `;
      await transaction`
        insert into public.session (id, account_id, user_id, token_hash, expires_at)
        values (${sessionId}, ${accountA}, ${userA}, ${oldHash}, now() + interval '1 day')
      `;
    });

    const accounts = await db`
      select account_id, role, status, active
      from public.auth_list_accounts(${oldHash})
      order by account_id
    `;
    expect(accounts).toEqual([
      { account_id: accountA, role: "owner", status: "active", active: true },
      { account_id: accountB, role: "viewer", status: "active", active: false },
    ]);

    const [switched] = await db`
      select * from public.auth_switch_account(
        ${oldHash}, ${accountB}, ${newHash}, now() + interval '1 day'
      )
    `;
    expect(switched).toMatchObject({ account_id: accountB, user_id: userA, session_id: sessionId });
    const oldSession = await db`
      select 1 from public.session where token_hash = ${oldHash}
    `;
    expect(oldSession).toEqual([]);
    const [current] = await db`
      select account_id, user_id, token_hash
      from public.session where id = ${sessionId}
    `;
    expect(current).toEqual({ account_id: accountB, user_id: userA, token_hash: newHash });

    const denied = await db`
      select * from public.auth_switch_account(
        ${newHash}, ${"00000000-0000-4000-8000-000000009999"}, ${"d".repeat(64)}, now() + interval '1 day'
      )
    `;
    expect(denied).toEqual([]);
  });
});
