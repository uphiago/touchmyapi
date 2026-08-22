import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbConnection, type DbConnection } from "../src/index";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";

describe("createDbConnection", () => {
  it("throws a clear configuration error when DATABASE_URL is absent", () => {
    expect(() => createDbConnection(undefined)).toThrow(/DATABASE_URL/);
  });
});

// Local integration check. Skipped unless RUN_DB_TESTS=1 so unit runs stay
// deterministic and never require a live PostgreSQL instance.
describe.skipIf(!RUN_DB_TESTS)("database connection (integration)", () => {
  let db!: DbConnection;

  beforeAll(() => {
    db = createDbConnection(process.env.DATABASE_URL);
  });

  afterAll(async () => {
    await db.end();
  });

  it("runs select 1 as ok", async () => {
    const [row] = await db`select 1 as ok`;
    expect(row?.ok).toBe(1);
  });
});
