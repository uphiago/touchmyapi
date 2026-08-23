import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRawDbConnection,
  type RawDbConnection,
  type RawDbTransaction,
} from "../../packages/db/src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for multi-user isolation tests");
  const parsed = new URL(value);
  if (
    !parsed.hostname.match(/^(127\.0\.0\.1|localhost)$/u) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Multi-user isolation tests require a loopback *_test database");
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("multi-user membership RLS and references", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForTest());
  });

  afterAll(async () => db?.end());

  it("keeps membership/invitation reads tenant-scoped and binds session/attestation actors", async () => {
    const run = crypto.randomUUID();
    const accountA = crypto.randomUUID();
    const accountB = crypto.randomUUID();
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const assessmentA = crypto.randomUUID();
    const assessmentB = crypto.randomUUID();
    const playbookKey = `multiuser-${run}`;
    const tokenA = run.replaceAll("-", "").padEnd(64, "a");

    try {
      await db
        .begin(async (tx) => {
          await tx`
        insert into public.account (id) values (${accountA}), (${accountB})
      `;
          await tx`
        insert into public."user" (id, account_id, provider, provider_subject, email)
        values
          (${userA}, ${accountA}, 'google', ${`multiuser-a-${run}`}, 'a@example.test'),
          (${userB}, ${accountB}, 'google', ${`multiuser-b-${run}`}, 'b@example.test')
      `;
          await tx`
        insert into public.account_membership (account_id, user_id, role, status)
        values (${accountA}, ${userA}, 'owner', 'active'), (${accountB}, ${userB}, 'owner', 'active')
      `;
          await tx`
        insert into public.account_invitation
          (account_id, token_hash, email, proposed_role, status, expires_at, invited_by_user_id)
        values (${accountA}, ${tokenA}, 'invitee@example.test', 'viewer', 'pending', now() + interval '1 day', ${userA})
      `;
          await tx`
        insert into public.playbook (key, playbook_version, target_category, contract_json)
        values (${playbookKey}, '1.0.0', 'surface', '{}'::jsonb)
      `;
          await tx`
        insert into public.assessment
          (id, account_id, target_category, target_json, scope_json, playbook_id, playbook_version, limits_json)
        values
          (${assessmentA}, ${accountA}, 'surface', '{}'::jsonb, '{}'::jsonb, ${playbookKey}, '1.0.0', '{}'::jsonb),
          (${assessmentB}, ${accountB}, 'surface', '{}'::jsonb, '{}'::jsonb, ${playbookKey}, '1.0.0', '{}'::jsonb)
      `;
          await tx`
        insert into public.session (account_id, user_id, token_hash, expires_at)
        values (${accountA}, ${userA}, ${"a".repeat(64)}, now() + interval '1 day')
      `;
          await tx`
        insert into public.authorization_attestation
          (account_id, assessment_id, user_id, target_json, terms_version)
        values (${accountA}, ${assessmentA}, ${userA}, '{}'::jsonb, '1')
      `;

          await tx.unsafe("set local role api_rls");
          await tx`select set_config('app.tenant', ${accountA}, true)`;
          expect(
            await tx`
        select account_id, user_id from public.account_membership order by account_id
      `,
          ).toEqual([{ account_id: accountA, user_id: userA }]);
          expect(
            await tx`
        select account_id, proposed_role from public.account_invitation
      `,
          ).toEqual([{ account_id: accountA, proposed_role: "viewer" }]);
          expect(await tx`select account_id from public.authorization_attestation`).toEqual([
            { account_id: accountA },
          ]);

          await tx.unsafe("reset role");
          await expectForeignKeyFailure(
            tx,
            () => tx`
          insert into public.session (account_id, user_id, token_hash, expires_at)
          values (${accountA}, ${userB}, ${"b".repeat(64)}, now() + interval '1 day')
        `,
          );
          await expectForeignKeyFailure(
            tx,
            () => tx`
          insert into public.authorization_attestation
            (account_id, assessment_id, user_id, target_json, terms_version)
          values (${accountA}, ${assessmentA}, ${userB}, '{}'::jsonb, 'cross-account')
        `,
          );
          await tx`select set_config('app.tenant', ${accountA}, true)`;
          await tx.unsafe("set local role api_rls");
          expect(
            await tx`select * from public.account_membership where account_id = ${accountB}`,
          ).toEqual([]);
          throw new Error("rollback multi-user isolation fixture");
        })
        .catch((error) => {
          expect(error.message).toBe("rollback multi-user isolation fixture");
        });
    } finally {
      await db.begin(async (tx) => {
        await tx`delete from public.authorization_attestation where account_id in (${accountA}, ${accountB})`;
        await tx`delete from public.session where account_id in (${accountA}, ${accountB})`;
        await tx`delete from public.account_invitation where account_id in (${accountA}, ${accountB})`;
        await tx`delete from public.account_membership where account_id in (${accountA}, ${accountB})`;
        await tx`delete from public.assessment where account_id in (${accountA}, ${accountB})`;
        await tx`delete from public."user" where account_id in (${accountA}, ${accountB})`;
        await tx`delete from public.account where id in (${accountA}, ${accountB})`;
        await tx`delete from public.playbook where key = ${playbookKey}`;
      });
    }
  });

  it("declares composite membership references for tenant-bound actors", async () => {
    const constraints = await db`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname in ('session_membership_fk', 'authorization_attestation_membership_fk')
      order by conname
    `;
    expect(constraints).toHaveLength(2);
    expect(constraints.map((row) => row.conname)).toEqual([
      "authorization_attestation_membership_fk",
      "session_membership_fk",
    ]);
    for (const row of constraints) {
      expect(row.definition).toMatch(
        /FOREIGN KEY \(account_id, user_id\) REFERENCES (?:public\.)?account_membership\(account_id, user_id\)/u,
      );
    }
  });
});

async function expectForeignKeyFailure(
  tx: RawDbTransaction,
  operation: () => Promise<unknown>,
): Promise<void> {
  await tx.unsafe("savepoint multiuser_fk");
  try {
    await operation();
    throw new Error("foreign-key operation unexpectedly succeeded");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "foreign-key operation unexpectedly succeeded"
    ) {
      throw error;
    }
    expect((error as { code?: string }).code).toBe("23503");
  } finally {
    await tx.unsafe("rollback to savepoint multiuser_fk");
    await tx.unsafe("release savepoint multiuser_fk");
  }
}
