import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawDbConnection, type RawDbConnection } from "../src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const normalizeRelationName = (value: string) => value.replaceAll('"', "");
const normalizeDefault = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/::"?public"?\./g, "::");
};
const normalizeCheck = (value: unknown): string =>
  String(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[()"]+/g, "")
    .replace(/\bpublic\./g, "")
    .trim();
if (!RUN_DB_TESTS) {
  console.info(
    "[schema.integration] PostgreSQL checks skipped; set RUN_DB_TESTS=1 and DATABASE_URL=postgres://.../<name>_test to run them.",
  );
}
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
  "audit_account_state",
  "audit_system_state",
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

const schemaDescribe = RUN_DB_TESTS ? describe : describe.skip;

schemaDescribe("PostgreSQL foundation schema", () => {
  let db!: RawDbConnection;

  beforeAll(() => {
    db = createRawDbConnection(databaseUrlForIntegration());
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
      if (
        table === "account" ||
        table === "playbook" ||
        table === "audit_event" ||
        table === "audit_system_state"
      )
        continue;
      expect(nullableByTable.get(table), table).toBe("NO");
    }
    expect(nullableByTable.get("audit_event")).toBe("YES");
    expect(nullableByTable.get("audit_account_state")).toBe("NO");

    const systemColumns = await db`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'audit_system_state'
      order by ordinal_position
    `;
    expect(systemColumns).toEqual([{ column_name: "id", data_type: "text", is_nullable: "NO" }]);

    const uniqueRows = await db`
      select c.conrelid::regclass::text as table_name, c.conname as constraint_name,
             array_agg(a.attname order by k.ordinality) as columns
      from pg_constraint c
      cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'u' and c.connamespace = 'public'::regnamespace
      group by c.conrelid, c.conname
      order by table_name, constraint_name
    `;
    const actualUnique = uniqueRows.map(
      (row) =>
        `${normalizeRelationName(row.table_name as string)}:${row.constraint_name}:${(row.columns as string[]).join(",")}`,
    );
    const expectedUnique = [
      "agent:agent_account_id_id_unique:account_id,id",
      "agent:agent_token_hash_unique:token_hash",
      "assessment:assessment_account_id_id_unique:account_id,id",
      "authorization_attestation:authorization_attestation_account_id_id_unique:account_id,id",
      "audit_event:audit_event_account_id_id_unique:account_id,id",
      "billing_event:billing_event_account_id_id_unique:account_id,id",
      "billing_event:billing_event_stripe_event_id_unique:stripe_event_id",
      "credential:credential_account_id_id_unique:account_id,id",
      "credit_entry:credit_entry_account_id_id_unique:account_id,id",
      "entitlement:entitlement_account_id_id_unique:account_id,id",
      "finding:finding_account_id_id_unique:account_id,id",
      "job:job_account_id_id_unique:account_id,id",
      "job:job_dedupe_key_unique:dedupe_key",
      "notification:notification_account_id_id_unique:account_id,id",
      "report:report_account_id_id_unique:account_id,id",
      "runner_execution:runner_execution_account_id_id_unique:account_id,id",
      "session:session_account_id_id_unique:account_id,id",
      "session:session_token_hash_unique:token_hash",
      "user:user_account_id_id_unique:account_id,id",
      "user:user_account_id_unique:account_id",
      "user:user_provider_subject_unique:provider,provider_subject",
      "verification:verification_account_id_id_unique:account_id,id",
    ].sort();
    expect(actualUnique).toEqual(expectedUnique);
  });

  it("matches the exact tenant-safe foreign-key matrix", async () => {
    const rows = await db`
      select child.relname as child_table, c.conname as constraint_name,
             parent.relname as parent_table,
             array_agg(child_attr.attname order by child_key.ordinality) as child_columns,
             array_agg(parent_attr.attname order by parent_key.ordinality) as parent_columns
      from pg_constraint c
      join pg_class child on child.oid = c.conrelid
      join pg_class parent on parent.oid = c.confrelid
      cross join lateral unnest(c.conkey) with ordinality as child_key(attnum, ordinality)
      join lateral unnest(c.confkey) with ordinality as parent_key(attnum, ordinality)
        on parent_key.ordinality = child_key.ordinality
      join pg_attribute child_attr on child_attr.attrelid = c.conrelid and child_attr.attnum = child_key.attnum
      join pg_attribute parent_attr on parent_attr.attrelid = c.confrelid and parent_attr.attnum = parent_key.attnum
      where c.contype = 'f' and child.relnamespace = 'public'::regnamespace
      group by child.relname, c.conname, parent.relname
      order by child_table, constraint_name
    `;
    const actual = rows.map(
      (row) =>
        `${row.child_table}:${row.constraint_name}:${row.parent_table}:${(row.child_columns as string[]).join(",")}>${(row.parent_columns as string[]).join(",")}`,
    );
    const expected = [
      "assessment:assessment_account_fk:account:account_id>id",
      "agent:agent_account_fk:account:account_id>id",
      "assessment:assessment_agent_fk:agent:account_id,agent_id>account_id,id",
      "assessment:assessment_playbook_fk:playbook:playbook_id,playbook_version>key,playbook_version",
      "assessment:assessment_verification_fk:verification:account_id,verification_ref>account_id,id",
      "authorization_attestation:authorization_attestation_assessment_fk:assessment:account_id,assessment_id>account_id,id",
      "authorization_attestation:authorization_attestation_user_fk:user:account_id,user_id>account_id,id",
      "audit_event:audit_event_account_fk:account:account_id>id",
      "audit_account_state:audit_account_state_account_fk:account:account_id>id",
      "audit_event:audit_event_assessment_fk:assessment:account_id,assessment_id>account_id,id",
      "audit_event:audit_event_job_fk:job:account_id,job_id>account_id,id",
      "audit_event:audit_event_prev_fk:audit_event:account_id,prev_event_id>account_id,id",
      "billing_event:billing_event_account_fk:account:account_id>id",
      "credential:credential_assessment_fk:assessment:account_id,assessment_id>account_id,id",
      "credit_entry:credit_entry_account_fk:account:account_id>id",
      "credit_entry:credit_entry_assessment_fk:assessment:account_id,assessment_id>account_id,id",
      "entitlement:entitlement_account_fk:account:account_id>id",
      "entitlement:entitlement_source_event_fk:billing_event:account_id,source_event_id>account_id,id",
      "finding:finding_assessment_fk:assessment:account_id,assessment_id>account_id,id",
      "job:job_account_fk:account:account_id>id",
      "job:job_assessment_fk:assessment:account_id,assessment_id>account_id,id",
      "notification:notification_account_fk:account:account_id>id",
      "notification:notification_assessment_fk:assessment:account_id,assessment_id>account_id,id",
      "report:report_assessment_fk:assessment:account_id,assessment_id>account_id,id",
      "runner_execution:runner_execution_job_fk:job:account_id,job_id>account_id,id",
      "session:session_account_user_fk:user:account_id,user_id>account_id,id",
      "user:user_account_fk:account:account_id>id",
      "verification:verification_account_fk:account:account_id>id",
    ].sort();
    expect(actual).toEqual(expected);
  });

  it("matches critical defaults, primary keys, nullability, and checks", async () => {
    const columns = await db`
      select table_name, column_name, data_type, udt_name, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'account' and column_name in ('id', 'status', 'settings_ia_enabled', 'created_at', 'deleted_at'))
          or (table_name = 'session' and column_name in ('id', 'token_hash', 'expires_at', 'family_id'))
          or (table_name = 'assessment' and column_name in ('target_json', 'limits_json', 'status', 'credits_estimate', 'credits_consumed', 'updated_at'))
          or (table_name = 'job' and column_name in ('status', 'attempts', 'max_attempts'))
          or (table_name = 'runner_execution' and column_name = 'cleaned_up')
          or (table_name = 'finding' and column_name = 'published')
          or (table_name = 'billing_event' and column_name in ('signature_valid', 'processing_status'))
          or (table_name = 'entitlement' and column_name = 'status')
          or (table_name = 'agent' and column_name = 'status'))
    `;
    const byColumn = new Map(columns.map((row) => [`${row.table_name}.${row.column_name}`, row]));
    const expectedColumns: Record<string, { defaultValue: string | null; nullable: "YES" | "NO" }> =
      {
        "account.id": { defaultValue: "gen_random_uuid()", nullable: "NO" },
        "account.status": { defaultValue: "'active'::account_status", nullable: "NO" },
        "account.settings_ia_enabled": { defaultValue: "true", nullable: "NO" },
        "account.created_at": { defaultValue: "now()", nullable: "NO" },
        "account.deleted_at": { defaultValue: null, nullable: "YES" },
        "session.id": { defaultValue: "gen_random_uuid()", nullable: "NO" },
        "session.token_hash": { defaultValue: null, nullable: "NO" },
        "session.expires_at": { defaultValue: null, nullable: "NO" },
        "session.family_id": { defaultValue: "gen_random_uuid()", nullable: "NO" },
        "assessment.target_json": { defaultValue: null, nullable: "NO" },
        "assessment.limits_json": { defaultValue: null, nullable: "NO" },
        "assessment.status": { defaultValue: "'draft'::assessment_status", nullable: "NO" },
        "assessment.credits_estimate": { defaultValue: "0", nullable: "NO" },
        "assessment.credits_consumed": { defaultValue: "0", nullable: "NO" },
        "assessment.updated_at": { defaultValue: "now()", nullable: "NO" },
        "job.status": { defaultValue: "'queued'::job_status", nullable: "NO" },
        "job.attempts": { defaultValue: "0", nullable: "NO" },
        "job.max_attempts": { defaultValue: "3", nullable: "NO" },
        "runner_execution.cleaned_up": { defaultValue: "false", nullable: "NO" },
        "finding.published": { defaultValue: "false", nullable: "NO" },
        "billing_event.signature_valid": { defaultValue: "false", nullable: "NO" },
        "billing_event.processing_status": {
          defaultValue: "'received'::billing_processing_status",
          nullable: "NO",
        },
        "entitlement.status": { defaultValue: "'active'::entitlement_status", nullable: "NO" },
        "agent.status": { defaultValue: "'active'::agent_status", nullable: "NO" },
      };
    for (const [name, expected] of Object.entries(expectedColumns)) {
      const column = byColumn.get(name);
      expect(column, name).toBeDefined();
      expect(column?.is_nullable, name).toBe(expected.nullable);
      expect(normalizeDefault(column?.column_default), name).toBe(expected.defaultValue);
    }
    expect(byColumn.get("session.token_hash")?.data_type).toBe("text");
    expect(byColumn.get("session.expires_at")?.data_type).toBe("timestamp with time zone");
    expect(byColumn.get("session.family_id")?.udt_name).toBe("uuid");
    expect(byColumn.get("assessment.target_json")?.udt_name).toBe("jsonb");
    expect(byColumn.get("assessment.limits_json")?.udt_name).toBe("jsonb");

    const primaryKeys = await db`
      select c.conrelid::regclass::text as table_name,
             array_agg(a.attname order by k.ordinality) as columns
      from pg_constraint c
      cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'p' and c.connamespace = 'public'::regnamespace
      group by c.conrelid
    `;
    const primaryByTable = new Map(
      primaryKeys.map((row) => [
        normalizeRelationName(row.table_name as string),
        row.columns as string[],
      ]),
    );
    for (const table of EXPECTED_TABLES.filter(
      (name) =>
        name !== "playbook" && name !== "audit_system_state" && name !== "audit_account_state",
    )) {
      expect(primaryByTable.get(table), table).toEqual(["id"]);
    }
    expect(primaryByTable.get("playbook")).toEqual(["key", "playbook_version"]);
    expect(primaryByTable.get("audit_system_state")).toEqual(["id"]);
    expect(primaryByTable.get("audit_account_state")).toEqual(["account_id"]);

    const [familyIndex] = await db`
      select indexdef
      from pg_indexes
      where schemaname = 'public' and tablename = 'session' and indexname = 'session_family_id_idx'
    `;
    expect(familyIndex?.indexdef).toContain("(family_id)");

    const checks = await db`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where contype = 'c' and connamespace = 'public'::regnamespace
      order by conname
    `;
    const actualChecks = new Map(
      checks.map((row) => [row.conname, normalizeCheck(row.definition)]),
    );
    expect(actualChecks).toEqual(
      new Map([
        ["assessment_credits_consumed_nonnegative", "check credits_consumed >= 0"],
        ["assessment_credits_estimate_nonnegative", "check credits_estimate >= 0"],
        ["job_attempts_nonnegative", "check attempts >= 0"],
        ["job_max_attempts_positive", "check max_attempts > 0"],
        ["audit_system_state_id_check", "check id = 'system'::text"],
      ]),
    );

    const [systemState] = await db`select id from public.audit_system_state`;
    expect(systemState?.id).toBe("system");
  });

  it("forces RLS on the singleton system audit lock table", async () => {
    const [state] = await db`
      select relrowsecurity, relforcerowsecurity
      from pg_class
      where oid = 'public.audit_system_state'::regclass
    `;
    expect(state).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("forces RLS on the per-account audit lock table", async () => {
    const [state] = await db`
      select relrowsecurity, relforcerowsecurity
      from pg_class
      where oid = 'public.audit_account_state'::regclass
    `;
    expect(state).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
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
