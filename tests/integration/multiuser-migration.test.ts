import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  createRawDbConnection,
  type RawDbConnection,
} from "../../packages/db/src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for migration review tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Migration review tests require a loopback *_test database");
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("multi-user expand-contract migration", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForTest());
  });

  afterAll(async () => db?.end());

  it("preserves the legacy identity column and its uniqueness during expand", async () => {
    const columns = await db`
      select column_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'user' and column_name in ('account_id', 'provider_subject')
      order by column_name
    `;
    expect(columns).toEqual([
      { column_name: "account_id", is_nullable: "NO" },
      { column_name: "provider_subject", is_nullable: "NO" },
    ]);

    const constraints = await db`
      select conname
      from pg_constraint
      where conrelid = 'public.user'::regclass and conname = 'user_account_id_unique'
    `;
    expect(constraints).toEqual([{ conname: "user_account_id_unique" }]);
  });

  it("keeps legacy users authorized through an owner membership and binds sessions to it", async () => {
    const run = crypto.randomUUID();
    const subject = `migration-review-${run}`;
    const email = `${run}@migration-review.example.test`;
    const sessionHash = run.replaceAll("-", "").padEnd(64, "0");
    let accountId = "";
    let userId = "";
    let sessionId = "";
    try {
      const [login] = await db.begin(async (tx) => {
        await tx.unsafe("set local role auth_bootstrap");
        return tx`select * from public.auth_complete_google_login(
          ${subject}, ${email}::citext, ${sessionHash},
          now() + interval '1 hour', null, null
        )`;
      });
      if (!login) throw new Error("auth fixture missing");
      accountId = login.account_id;
      userId = login.user_id;
      sessionId = login.session_id;

      const [legacy] = await db`
        select u.account_id, u.id as user_id, m.role, m.status
        from public."user" u
        left join public.account_membership m on m.account_id = u.account_id and m.user_id = u.id
        where u.id = ${userId}
      `;
      expect(legacy).toMatchObject({
        account_id: accountId,
        user_id: userId,
        role: "owner",
        status: "active",
      });

      const [session] = await db`
        select s.account_id, s.user_id, m.status
        from public.session s
        join public.account_membership m on m.account_id = s.account_id and m.user_id = s.user_id
        where s.id = ${sessionId}
      `;
      expect(session).toEqual({ account_id: accountId, user_id: userId, status: "active" });
    } finally {
      if (sessionId) await db`delete from public.session where id = ${sessionId}`;
      if (accountId)
        await db`delete from public.account_membership where account_id = ${accountId}`;
      if (userId) await db`delete from public."user" where id = ${userId}`;
      if (accountId) await db`delete from public.audit_event where account_id = ${accountId}`;
      if (accountId)
        await db`delete from public.audit_account_state where account_id = ${accountId}`;
      if (accountId)
        await db`delete from public.queue_tenant_state where account_id = ${accountId}`;
      if (accountId) await db`delete from public.account where id = ${accountId}`;
    }
  });

  it("supports dual-read account discovery and explicit session rotation", async () => {
    const run = crypto.randomUUID();
    const subject = `migration-switch-${run}`;
    const email = `${run}@migration-switch.example.test`;
    let accountA = "";
    let accountB = "";
    let userId = "";
    let sessionId = "";
    const oldHash = run.replaceAll("-", "").padEnd(64, "a").slice(0, 64);
    const newHash = run.replaceAll("-", "").padEnd(64, "b").slice(0, 64);
    try {
      const [login] = await db.begin(async (tx) => {
        await tx.unsafe("set local role auth_bootstrap");
        return tx`select * from public.auth_complete_google_login(
          ${subject}, ${email}::citext, ${oldHash}, now() + interval '1 hour', null, null
        )`;
      });
      if (!login) throw new Error("auth fixture missing");
      accountA = login.account_id;
      userId = login.user_id;
      sessionId = login.session_id;
      await db.begin(async (tx) => {
        const [created] = await tx`insert into public.account default values returning id`;
        if (!created) throw new Error("account fixture missing");
        accountB = created.id;
        await tx`insert into public.account_membership (account_id, user_id, role, status)
          values (${accountB}, ${userId}, 'viewer', 'active')`;
      });

      const accounts =
        await db`select account_id, role, active from public.auth_list_accounts(${oldHash}) order by account_id`;
      expect(accounts).toHaveLength(2);
      expect(accounts.find((row) => row.account_id === accountA)).toMatchObject({
        role: "owner",
        active: true,
      });
      expect(accounts.find((row) => row.account_id === accountB)).toMatchObject({
        role: "viewer",
        active: false,
      });

      const [switched] = await db`select * from public.auth_switch_account(
        ${oldHash}, ${accountB}, ${newHash}, now() + interval '1 hour'
      )`;
      expect(switched).toMatchObject({
        account_id: accountB,
        user_id: userId,
        session_id: sessionId,
      });
      expect(await db`select 1 from public.session where token_hash = ${oldHash}`).toEqual([]);
      expect(await db`select account_id from public.session where id = ${sessionId}`).toEqual([
        { account_id: accountB },
      ]);
    } finally {
      if (sessionId) await db`delete from public.session where id = ${sessionId}`;
      if (accountA)
        await db`delete from public.account_membership where account_id in (${accountA}, ${accountB || accountA})`;
      if (userId) await db`delete from public."user" where id = ${userId}`;
      if (accountA)
        await db`delete from public.audit_event where account_id in (${accountA}, ${accountB || accountA})`;
      if (accountA)
        await db`delete from public.audit_account_state where account_id in (${accountA}, ${accountB || accountA})`;
      if (accountA)
        await db`delete from public.queue_tenant_state where account_id in (${accountA}, ${accountB || accountA})`;
      if (accountB) await db`delete from public.account where id = ${accountB}`;
      if (accountA) await db`delete from public.account where id = ${accountA}`;
    }
  });

  it("has no orphan memberships and keeps the quarantine decision explicit", async () => {
    const orphans = await db`
      select m.account_id, m.user_id
      from public.account_membership m
      left join public.account a on a.id = m.account_id
      left join public."user" u on u.id = m.user_id
      where a.id is null or u.id is null
    `;
    expect(orphans).toEqual([]);

    const migration = await readFile(
      new URL("../../packages/db/migrations/0011_multiuser_membership.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toMatch(/email matching|never match by email/i);
    expect(migration).toMatch(/explicit support migration/i);
    expect(migration).toMatch(
      /insert into public\.account_membership[\s\S]*select u\.account_id, u\.id, 'owner'/i,
    );
  });
});
