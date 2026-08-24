import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for delivery schema tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Delivery schema tests require a loopback *_test database");
  }
  return value;
}

describe.skipIf(!RUN_DB_TESTS)("delivery schema", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForTest());
  });

  afterAll(async () => db?.end());

  it("has deterministic delivery keys and isolated runtime connectors", async () => {
    const columns = await db.unsafe(
      `select table_name, column_name, is_nullable
       from information_schema.columns
       where table_schema = 'public'
         and (table_name, column_name) in (
           ('finding', 'source_key'),
           ('notification', 'event_key'),
           ('runner_execution', 'fencing_token')
         )
       order by table_name`,
    );
    expect(columns).toEqual([
      { table_name: "finding", column_name: "source_key", is_nullable: "NO" },
      { table_name: "notification", column_name: "event_key", is_nullable: "NO" },
      { table_name: "runner_execution", column_name: "fencing_token", is_nullable: "NO" },
    ]);

    const connectors = await db.unsafe(
      `select rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit
       from pg_roles where rolname in ('worker_connector', 'reporting_connector')
       order by rolname`,
    );
    expect(connectors).toEqual([
      {
        rolname: "reporting_connector",
        rolcanlogin: true,
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
      },
      {
        rolname: "worker_connector",
        rolcanlogin: true,
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
      },
    ]);
    const memberships = await db.unsafe(
      `select member.rolname as member, parent.rolname as parent, relation.set_option
       from pg_auth_members relation
       join pg_roles parent on parent.oid = relation.roleid
       join pg_roles member on member.oid = relation.member
       where member.rolname in ('worker_connector', 'reporting_connector')
       order by member.rolname, parent.rolname`,
    );
    expect(memberships).toEqual([
      { member: "reporting_connector", parent: "reporting_rls", set_option: true },
      { member: "worker_connector", parent: "worker_rls", set_option: true },
    ]);
  });
});
