import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbConnection, type DbConnection } from "../src/index";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const EXPECTED_TABLES = [
  "account",
  "user",
  "session",
  "assessment",
  "authorization_attestation",
  "verification",
  "playbook",
  "job",
  "runner_execution",
  "credential",
  "finding",
  "report",
  "credit_entry",
  "billing_event",
  "entitlement",
  "agent",
  "audit_event",
  "notification",
] as const;

const EXPECTED_ENUMS: Record<string, string[]> = {
  account_status: ["active", "deleted", "revoked"],
  identity_provider: ["google", "github", "x"],
  target_category: ["web", "api", "surface", "genai", "internal"],
  assessment_status: [
    "draft",
    "awaiting_verification",
    "queued",
    "running",
    "analyzing",
    "completed",
    "failed",
    "cancelled",
  ],
  verification_method: ["http_file", "dns_txt"],
  verification_status: ["pending", "verified", "expired", "failed"],
  job_status: ["queued", "running", "succeeded", "failed", "cancelled", "stale_recovered"],
  severity: ["info", "low", "medium", "high", "critical"],
  report_kind: ["pdf_technical", "pdf_executive", "json"],
  billing_processing_status: ["received", "processed", "failed"],
  entitlement_plan: ["free_unverified", "free_verified", "pro", "lifetime"],
  entitlement_status: ["active", "expired", "revoked"],
  agent_status: ["active", "revoked", "expired"],
  audit_action: [
    "request",
    "authz",
    "verify",
    "policy",
    "dispatch",
    "runner",
    "artifacts",
    "analyze",
    "publish",
    "download",
    "billing",
    "delete",
  ],
};

function databaseUrlForIntegration(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for DB integration tests");
  const parsed = new URL(databaseUrl);
  if (!parsed.pathname.slice(1).endsWith("_test")) {
    throw new Error(
      `Refusing integration test database that does not end in _test: ${parsed.pathname}`,
    );
  }
  return databaseUrl;
}

describe.skipIf(!RUN_DB_TESTS)("PostgreSQL foundation schema", () => {
  let db!: DbConnection;

  beforeAll(() => {
    db = createDbConnection(databaseUrlForIntegration());
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  it("uses PostgreSQL 16 and has exactly the foundation tables", async () => {
    const [version] = await db`select current_setting('server_version_num')::int as version`;
    expect(Math.floor(Number(version?.version) / 10000)).toBe(16);

    const rows = await db`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    expect(rows.map((row) => row.table_name)).toEqual([...EXPECTED_TABLES].sort());

    const [countRow] = await db`select count(*)::int as count from assessment`;
    expect(countRow?.count).toBe(0);
  });

  it("installs required extensions, closed enums, and storage types", async () => {
    const extensions = await db`
      select extname from pg_extension where extname in ('pgcrypto', 'citext') order by extname
    `;
    expect(extensions.map((row) => row.extname)).toEqual(["citext", "pgcrypto"]);

    for (const [enumName, labels] of Object.entries(EXPECTED_ENUMS)) {
      const rows = await db`
        select e.enumlabel
        from pg_type t
        join pg_enum e on e.enumtypid = t.oid
        where t.typname = ${enumName}
        order by e.enumsortorder
      `;
      expect(
        rows.map((row) => row.enumlabel),
        enumName,
      ).toEqual(labels);
    }

    const columns = await db`
      select table_name, column_name, data_type, udt_name
      from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'user' and column_name = 'email')
          or (table_name = 'assessment' and column_name in ('target_json', 'scope_json'))
          or (table_name = 'credential' and column_name = 'encrypted_payload')
          or (table_name = 'account' and column_name = 'created_at'))
    `;
    const byColumn = new Map(columns.map((row) => [`${row.table_name}.${row.column_name}`, row]));
    expect(byColumn.get("user.email")?.udt_name).toBe("citext");
    expect(byColumn.get("assessment.target_json")?.udt_name).toBe("jsonb");
    expect(byColumn.get("assessment.scope_json")?.udt_name).toBe("jsonb");
    expect(byColumn.get("credential.encrypted_payload")?.udt_name).toBe("bytea");
    expect(byColumn.get("account.created_at")?.data_type).toBe("timestamp with time zone");
  });

  it("enforces tenant ownership columns and required unique constraints", async () => {
    const accountColumns = await db`
      select table_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and column_name = 'account_id'
      order by table_name
    `;
    const nullableByTable = new Map(accountColumns.map((row) => [row.table_name, row.is_nullable]));
    for (const table of EXPECTED_TABLES) {
      if (table === "account" || table === "playbook" || table === "audit_event") continue;
      expect(nullableByTable.get(table), table).toBe("NO");
    }
    expect(nullableByTable.get("audit_event")).toBe("YES");

    const uniqueRows = await db`
      select table_name, constraint_name
      from information_schema.table_constraints
      where table_schema = 'public' and constraint_type = 'UNIQUE'
    `;
    const uniqueNames = new Set(
      uniqueRows.map((row) => `${row.table_name}:${row.constraint_name}`),
    );
    expect([...uniqueNames].some((value) => value.startsWith("user:"))).toBe(true);
    expect([...uniqueNames].some((value) => value.startsWith("billing_event:"))).toBe(true);
    expect([...uniqueNames].some((value) => value.startsWith("job:"))).toBe(true);
    expect([...uniqueNames].some((value) => value.startsWith("agent:"))).toBe(true);
  });

  it("requires and uniquely stores opaque session token hashes", async () => {
    const rows = await db`
      select column_name, is_nullable, data_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'session' and column_name = 'token_hash'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_nullable).toBe("NO");
    expect(rows[0]?.data_type).toBe("text");

    const accountId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const hash = `sha256:${crypto.randomUUID()}`;
    const rollback = new Error("session hash fixture rollback");
    await db
      .begin(async (tx) => {
        await tx`insert into account (id) values (${accountId})`;
        await tx`insert into "user" (id, account_id, provider, provider_subject) values (${userId}, ${accountId}, 'google', ${`session-test-${userId}`})`;
        await tx`insert into session (id, account_id, user_id, token_hash, expires_at) values (${sessionId}, ${accountId}, ${userId}, ${hash}, now() + interval '1 hour')`;
        const [stored] = await tx`select token_hash from session where id = ${sessionId}`;
        expect(stored?.token_hash).toBe(hash);

        await tx`savepoint session_hash_check`;
        await expect(
          tx`insert into session (id, account_id, user_id, expires_at) values (${crypto.randomUUID()}, ${accountId}, ${userId}, now() + interval '1 hour')`,
        ).rejects.toThrow();
        await tx`rollback to savepoint session_hash_check`;
        await tx`savepoint session_hash_unique_check`;
        await expect(
          tx`insert into session (id, account_id, user_id, token_hash, expires_at) values (${crypto.randomUUID()}, ${accountId}, ${userId}, ${hash}, now() + interval '1 hour')`,
        ).rejects.toThrow();
        await tx`rollback to savepoint session_hash_unique_check`;
        throw rollback;
      })
      .catch((error) => {
        expect(error).toBe(rollback);
      });
  });

  it("rejects cross-account links through composite tenant foreign keys", async () => {
    const accountA = crypto.randomUUID();
    const accountB = crypto.randomUUID();
    const userA = crypto.randomUUID();
    const assessmentA = crypto.randomUUID();
    const providerSubject = `schema-test-${userA}`;
    const rollback = new Error("schema fixture rollback");
    await db
      .begin(async (tx) => {
        await tx`insert into account (id) values (${accountA}), (${accountB})`;
        await tx`insert into "user" (id, account_id, provider, provider_subject) values (${userA}, ${accountA}, 'google', ${providerSubject})`;
        await tx`insert into playbook (key, playbook_version, target_category, contract_json) values ('schema-test', '1.0.0', 'web', '{}')`;
        await tx`insert into assessment (id, account_id, target_category, target_json, scope_json, playbook_id, playbook_version, limits_json) values (${assessmentA}, ${accountA}, 'web', '{}', '{}', 'schema-test', '1.0.0', '{}')`;

        const rejected = async (query: (savepoint: typeof tx) => Promise<unknown>) => {
          await tx`savepoint cross_account_check`;
          await expect(query(tx)).rejects.toThrow();
          await tx`rollback to savepoint cross_account_check`;
        };
        await rejected(
          (savepoint) =>
            savepoint`insert into session (id, account_id, user_id, expires_at) values (${crypto.randomUUID()}, ${accountB}, ${userA}, now() + interval '1 hour')`,
        );
        await rejected(
          (savepoint) =>
            savepoint`insert into authorization_attestation (id, account_id, assessment_id, user_id, target_json, terms_version) values (${crypto.randomUUID()}, ${accountB}, ${assessmentA}, ${userA}, '{}', 'test')`,
        );
        throw rollback;
      })
      .catch((error) => {
        expect(error).toBe(rollback);
      });
  });
});
