import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const describeDb = RUN_DB_TESTS ? describe : describe.skip;
const subjectPrefix = "provider-auth-integration-";
const sessionHash = (label: string) =>
  createHash("sha256").update(`${subjectPrefix}${label}`).digest("hex");

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for provider auth tests");
  const parsed = new URL(value);
  if (!/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) || !parsed.pathname.endsWith("_test")) {
    throw new Error("Provider auth tests require a loopback *_test database");
  }
  return value;
}

async function cleanup(db: RawDbConnection): Promise<void> {
  const users = await db`
    select id, account_id from public."user"
    where provider_subject like ${`${subjectPrefix}%`}
  `;
  for (const user of users) {
    await db.begin(async (transaction) => {
      await transaction`delete from public.session where user_id = ${user.id}`;
      await transaction`delete from public.audit_event where account_id = ${user.account_id}`;
      await transaction`delete from public.audit_account_state where account_id = ${user.account_id}`;
      await transaction`delete from public.account_membership where user_id = ${user.id}`;
      await transaction`delete from public.queue_tenant_state where account_id = ${user.account_id}`;
      await transaction`delete from public."user" where id = ${user.id}`;
      await transaction`delete from public.account where id = ${user.account_id}`;
    });
  }
}

describeDb("provider-neutral authentication bootstrap", () => {
  let db!: RawDbConnection;
  let concurrentDb!: RawDbConnection;

  beforeAll(async () => {
    const databaseUrl = databaseUrlForTest();
    db = createRawDbConnection(databaseUrl);
    concurrentDb = createRawDbConnection(databaseUrl);
    await cleanup(db);
  });

  afterAll(async () => {
    if (db) await cleanup(db);
    await Promise.all([db?.end(), concurrentDb?.end()]);
  });

  async function login(
    connection: RawDbConnection,
    subject: string,
    sessionHash: string,
    email = "owner@example.test",
    provider = "github",
  ) {
    return connection`
      select * from public.auth_complete_provider_login(
        ${provider}::public.identity_provider,
        ${subject},
        ${email}::public.citext,
        ${sessionHash},
        now() + interval '1 day',
        '127.0.0.1'::inet,
        'provider-auth-integration'
      )
    `;
  }

  it("creates one owner workspace, queue state, session, and chained audit event", async () => {
    const subject = `${subjectPrefix}first`;
    const [created] = await login(db, subject, sessionHash("first"));

    expect(created).toMatchObject({
      account_id: expect.any(String),
      user_id: expect.any(String),
      session_id: expect.any(String),
    });
    const [snapshot] = await db`
      select
        (select count(*)::int from public.account_membership
          where account_id = ${created?.account_id} and user_id = ${created?.user_id}
            and role = 'owner' and status = 'active') as memberships,
        (select count(*)::int from public.queue_tenant_state
          where account_id = ${created?.account_id}) as queue_states,
        (select count(*)::int from public.session
          where account_id = ${created?.account_id} and user_id = ${created?.user_id}) as sessions
    `;
    expect(snapshot).toEqual({ memberships: 1, queue_states: 1, sessions: 1 });
    const [audit] = await db`
      select actor, action, payload_json
      from public.audit_event
      where account_id = ${created?.account_id}
      order by chain_seq desc limit 1
    `;
    expect(audit).toEqual({
      actor: "github_oauth",
      action: "authz",
      payload_json: { event: "login", provider: "github" },
    });
  });

  it("reuses the immutable provider identity and updates only contact email", async () => {
    const subject = `${subjectPrefix}returning`;
    const [first] = await login(db, subject, sessionHash("returning-first"));
    const [returning] = await login(
      db,
      subject,
      sessionHash("returning-second"),
      "updated@example.test",
    );

    expect(returning?.user_id).toBe(first?.user_id);
    expect(returning?.account_id).toBe(first?.account_id);
    const [snapshot] = await db`
      select u.email::text as email,
        (select count(*)::int from public.account_membership m where m.user_id = u.id) as memberships,
        (select count(*)::int from public.session s where s.user_id = u.id) as sessions
      from public."user" u where u.id = ${first?.user_id}
    `;
    expect(snapshot).toEqual({ email: "updated@example.test", memberships: 1, sessions: 2 });
  });

  it("serializes concurrent first login without duplicating identity or workspace", async () => {
    const subject = `${subjectPrefix}concurrent`;
    const [left, right] = await Promise.all([
      login(db, subject, sessionHash("concurrent-left")),
      login(concurrentDb, subject, sessionHash("concurrent-right")),
    ]);

    expect(left[0]?.user_id).toBe(right[0]?.user_id);
    expect(left[0]?.account_id).toBe(right[0]?.account_id);
    const [snapshot] = await db`
      select
        (select count(*)::int from public."user" where provider = 'github' and provider_subject = ${subject}) as users,
        (select count(*)::int from public.account_membership where user_id = ${left[0]?.user_id}) as memberships,
        (select count(*)::int from public.session where user_id = ${left[0]?.user_id}) as sessions
    `;
    expect(snapshot).toEqual({ users: 1, memberships: 1, sessions: 2 });
  });

  it("keeps disabled providers and invalid session material fail-closed", async () => {
    expect(
      await login(db, `${subjectPrefix}x`, sessionHash("disabled-x"), "x@example.test", "x"),
    ).toEqual([]);
    expect(await login(db, `${subjectPrefix}invalid`, "short")).toEqual([]);
  });
});
