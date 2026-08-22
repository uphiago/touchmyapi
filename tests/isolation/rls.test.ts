import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  createDbConnection,
  type DbConnection,
  type DbTransaction,
} from "../../packages/db/src/index";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const describeDb = RUN_DB_TESTS ? describe : describe.skip;
const TENANT_TABLES = [
  "account",
  "user",
  "session",
  "assessment",
  "authorization_attestation",
  "verification",
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
const SELECT_GRANTED: Record<string, ReadonlySet<string>> = {
  api_rls: new Set([
    "account",
    "user",
    "assessment",
    "authorization_attestation",
    "verification",
    "playbook",
    "credential",
    "finding",
    "report",
    "credit_entry",
    "entitlement",
    "agent",
    "audit_event",
    "notification",
  ]),
  worker_rls: new Set(TENANT_TABLES.filter((table) => table !== "session")),
  reporting_rls: new Set([
    "account",
    "user",
    "assessment",
    "authorization_attestation",
    "verification",
    "playbook",
    "job",
    "runner_execution",
    "finding",
    "report",
    "credit_entry",
    "billing_event",
    "entitlement",
    "agent",
    "audit_event",
    "notification",
  ]),
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
type Tx = DbTransaction;
type TenantRows = {
  accountId: string;
  userId: string;
  sessionId: string;
  assessmentId: string;
  verificationId: string;
  attestationId: string;
  credentialId: string;
  agentId: string;
  jobId: string;
  runnerExecutionId: string;
  findingId: string;
  reportId: string;
  creditEntryId: string;
  billingEventId: string;
  entitlementId: string;
  auditEventId: string;
  notificationId: string;
};

async function expectDenied(tx: Tx, operation: () => Promise<unknown>, message: RegExp) {
  await tx.unsafe("SAVEPOINT denied_operation");
  try {
    await operation();
    throw new Error("operation unexpectedly succeeded");
  } catch (error: unknown) {
    const pgError = error as { code?: string; message?: string };
    if (pgError.message === "operation unexpectedly succeeded") throw error;
    expect(pgError.code).toBe("42501");
    expect(pgError.message).toMatch(message);
  } finally {
    await tx.unsafe("ROLLBACK TO SAVEPOINT denied_operation");
    await tx.unsafe("RELEASE SAVEPOINT denied_operation");
  }
}

async function expectZeroOrPermission(tx: Tx, operation: () => Promise<unknown>) {
  await tx.unsafe("SAVEPOINT mutation_probe");
  try {
    const result = (await operation()) as { count?: number };
    expect(result.count ?? 0).toBe(0);
  } catch (error: unknown) {
    const pgError = error as { code?: string; message?: string };
    expect(pgError.code).toBe("42501");
    expect(pgError.message).toMatch(/permission denied/);
  }
  await tx.unsafe("ROLLBACK TO SAVEPOINT mutation_probe");
  await tx.unsafe("RELEASE SAVEPOINT mutation_probe");
}

async function createTenantRows(
  tx: Tx,
  accountId: string,
  userId: string,
  sessionId: string,
  suffix: string,
  playbookKey: string,
): Promise<TenantRows> {
  const playbookVersion = "1.0.0";
  const setTenant = async (role: string) => {
    await tx.unsafe(`set local role ${role}`);
    await tx`select set_config('app.tenant', ${accountId}, true)`;
  };
  await setTenant("api_rls");
  const [assessment] = await tx`insert into public.assessment
    (account_id, target_category, target_json, scope_json, playbook_id, playbook_version, limits_json)
    values (${accountId}, 'surface', '{}'::jsonb, '{}'::jsonb, ${playbookKey}, ${playbookVersion}, '{}'::jsonb)
    returning id`;
  if (!assessment) throw new Error("assessment fixture missing");
  const [verification] = await tx`insert into public.verification
    (account_id, target_json, challenge_token, challenge_host)
    values (${accountId}, '{}'::jsonb, ${`challenge-${suffix}`}, 'example.test') returning id`;
  if (!verification) throw new Error("verification fixture missing");
  const [attestation] = await tx`insert into public.authorization_attestation
    (account_id, assessment_id, user_id, target_json, terms_version)
    values (${accountId}, ${assessment.id}, ${userId}, '{}'::jsonb, '1') returning id`;
  if (!attestation) throw new Error("attestation fixture missing");
  const [credential] = await tx`insert into public.credential
    (account_id, assessment_id, encrypted_payload, key_id, purpose)
    values (${accountId}, ${assessment.id}, decode('00', 'hex'), 'test-key', 'fixture') returning id`;
  if (!credential) throw new Error("credential fixture missing");
  const [agent] = await tx`insert into public.agent
    (account_id, name, token_hash, fingerprint)
    values (${accountId}, ${`agent-${suffix}`}, ${sha256(`agent-token-${suffix}`)}, 'fixture') returning id`;
  if (!agent) throw new Error("agent fixture missing");
  const [auditEvent] = await tx`insert into public.audit_event
    (account_id, actor, action, payload_json)
    values (${accountId}, 'fixture', 'request', '{}'::jsonb) returning id`;
  if (!auditEvent) throw new Error("audit fixture missing");

  await setTenant("worker_rls");
  const [notification] = await tx`insert into public.notification
    (account_id, assessment_id, kind)
    values (${accountId}, ${assessment.id}, 'fixture') returning id`;
  if (!notification) throw new Error("notification fixture missing");
  const [job] = await tx`insert into public.job
    (account_id, assessment_id, playbook_version, job_spec_json, dedupe_key)
    values (${accountId}, ${assessment.id}, ${playbookVersion}, '{}'::jsonb, ${`dedupe-${suffix}`}) returning id`;
  if (!job) throw new Error("job fixture missing");
  const [runnerExecution] = await tx`insert into public.runner_execution
    (account_id, job_id, sandbox_impl)
    values (${accountId}, ${job.id}, 'fixture') returning id`;
  if (!runnerExecution) throw new Error("runner execution fixture missing");
  const [finding] = await tx`insert into public.finding
    (account_id, assessment_id, title, category, severity)
    values (${accountId}, ${assessment.id}, 'fixture', 'fixture', 'low') returning id`;
  if (!finding) throw new Error("finding fixture missing");
  const [report] = await tx`insert into public.report
    (account_id, assessment_id, kind, object_key, contract_version, sanitized)
    values (${accountId}, ${assessment.id}, 'json', ${`fixture-${suffix}`}, '1', false) returning id`;
  if (!report) throw new Error("report fixture missing");
  await tx.unsafe("reset role");
  const [creditEntry] = await tx`insert into public.credit_entry
    (account_id, assessment_id, credits, reason)
    values (${accountId}, ${assessment.id}, 1, 'fixture') returning id`;
  if (!creditEntry) throw new Error("credit entry fixture missing");
  const [billingEvent] = await tx`insert into public.billing_event
    (account_id, stripe_event_id, type, payload_minimal_json, signature_valid, event_version)
    values (${accountId}, ${`evt-${suffix}`}, 'fixture', '{}'::jsonb, true, '1') returning id`;
  if (!billingEvent) throw new Error("billing event fixture missing");
  const [entitlement] = await tx`insert into public.entitlement
    (account_id, plan, source_event_id)
    values (${accountId}, 'free_unverified', ${billingEvent.id}) returning id`;
  if (!entitlement) throw new Error("entitlement fixture missing");
  return {
    accountId,
    userId,
    sessionId,
    assessmentId: assessment.id,
    verificationId: verification.id,
    attestationId: attestation.id,
    credentialId: credential.id,
    agentId: agent.id,
    jobId: job.id,
    runnerExecutionId: runnerExecution.id,
    findingId: finding.id,
    reportId: report.id,
    creditEntryId: creditEntry.id,
    billingEventId: billingEvent.id,
    entitlementId: entitlement.id,
    auditEventId: auditEvent.id,
    notificationId: notification.id,
  };
}

function tenantIds(rows: TenantRows): Record<(typeof TENANT_TABLES)[number], string> {
  return {
    account: rows.accountId,
    user: rows.userId,
    session: rows.sessionId,
    assessment: rows.assessmentId,
    authorization_attestation: rows.attestationId,
    verification: rows.verificationId,
    job: rows.jobId,
    runner_execution: rows.runnerExecutionId,
    credential: rows.credentialId,
    finding: rows.findingId,
    report: rows.reportId,
    credit_entry: rows.creditEntryId,
    billing_event: rows.billingEventId,
    entitlement: rows.entitlementId,
    agent: rows.agentId,
    audit_event: rows.auditEventId,
    notification: rows.notificationId,
  };
}

async function expectZeroOrPermissionForEveryTable(
  tx: Tx,
  rows: TenantRows,
  command: "update" | "delete",
) {
  const ids = tenantIds(rows);
  for (const table of TENANT_TABLES) {
    const id = ids[table];
    await expectZeroOrPermission(tx, () =>
      command === "update"
        ? tx.unsafe(`update public."${table}" set id = id where id = $1`, [id])
        : tx.unsafe(`delete from public."${table}" where id = $1`, [id]),
    );
  }
}

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for PostgreSQL isolation tests");
  const database = new URL(value).pathname.slice(1);
  if (!database.endsWith("_test")) throw new Error(`Refusing non-test database: ${database}`);
  return value;
}

describeDb("PostgreSQL default-deny tenant isolation", () => {
  let db!: DbConnection;
  beforeAll(() => {
    db = createDbConnection(databaseUrlForTest());
  });
  afterAll(async () => db?.end());

  it("denies reads and real DML without a valid tenant for api and worker", async () => {
    await db
      .begin(async (tx) => {
        const run = randomUUID();
        await tx.unsafe("set local role auth_bootstrap");
        const [a] = await tx`select * from public.auth_complete_google_login(
        ${`subject-a-${run}`}, 'a@example.test'::citext, ${sha256(`a-${run}`)}, now() + interval '1 hour', null, null
      )`;
        const [b] = await tx`select * from public.auth_complete_google_login(
        ${`subject-b-${run}`}, 'b@example.test'::citext, ${sha256(`b-${run}`)}, now() + interval '1 hour', null, null
      )`;
        if (!a || !b) throw new Error("auth fixture missing");
        await tx.unsafe("reset role");
        const playbookKey = `rls-${run}`;
        await tx`insert into public.playbook (key, playbook_version, target_category, contract_json)
        values (${playbookKey}, '1.0.0', 'surface', '{}'::jsonb)`;
        const rowsA = await createTenantRows(
          tx,
          a.account_id,
          a.user_id,
          a.session_id,
          `${run}-a`,
          playbookKey,
        );
        const rowsB = await createTenantRows(
          tx,
          b.account_id,
          b.user_id,
          b.session_id,
          `${run}-b`,
          playbookKey,
        );
        expect(rowsB.accountId).not.toBe(rowsA.accountId);

        for (const role of ["api_rls", "worker_rls", "reporting_rls"]) {
          await tx.unsafe(`set local role ${role}`);
          for (const setting of [null, "", "malformed"]) {
            if (setting === null) await tx.unsafe("reset app.tenant");
            else await tx`select set_config('app.tenant', ${setting}, true)`;
            for (const table of TENANT_TABLES) {
              await tx.unsafe("SAVEPOINT read_probe");
              try {
                const rows = await tx.unsafe(`select * from public."${table}"`);
                expect(rows, `${role}/${table}/${setting}`).toEqual([]);
              } catch (error: unknown) {
                const pgError = error as { code?: string; message?: string };
                if (pgError.code !== "42501") throw error;
                expect(pgError.message).toMatch(/permission denied/);
              }
              await tx.unsafe("ROLLBACK TO SAVEPOINT read_probe");
              await tx.unsafe("RELEASE SAVEPOINT read_probe");
            }
          }
        }

        await tx.unsafe("set local role api_rls");
        await tx.unsafe("reset app.tenant");
        await expectZeroOrPermissionForEveryTable(tx, rowsA, "update");
        await expectZeroOrPermissionForEveryTable(tx, rowsA, "delete");
        for (const operation of [
          () =>
            tx`update public.account set settings_ia_enabled = false where id = ${rowsA.accountId}`,
          () => tx`update public.assessment set status = 'queued' where id = ${rowsA.assessmentId}`,
          () =>
            tx`update public.verification set status = 'verified' where id = ${rowsA.verificationId}`,
          () => tx`update public.credential set purpose = 'probe' where id = ${rowsA.credentialId}`,
          () => tx`update public.agent set name = 'probe' where id = ${rowsA.agentId}`,
          () =>
            tx`update public.notification set read_at = now() where id = ${rowsA.notificationId}`,
          () => tx`delete from public.credential where id = ${rowsA.credentialId}`,
          () => tx`delete from public.agent where id = ${rowsA.agentId}`,
        ])
          await expectZeroOrPermission(tx, operation);

        await tx.unsafe("set local role worker_rls");
        await tx.unsafe("reset app.tenant");
        await expectZeroOrPermissionForEveryTable(tx, rowsA, "update");
        await expectZeroOrPermissionForEveryTable(tx, rowsA, "delete");
        for (const operation of [
          () => tx`update public.assessment set status = 'queued' where id = ${rowsA.assessmentId}`,
          () =>
            tx`update public.verification set status = 'verified' where id = ${rowsA.verificationId}`,
          () => tx`update public.job set status = 'running' where id = ${rowsA.jobId}`,
          () =>
            tx`update public.runner_execution set cleaned_up = true where id = ${rowsA.runnerExecutionId}`,
          () => tx`update public.finding set title = 'probe' where id = ${rowsA.findingId}`,
          () => tx`update public.report set sanitized = true where id = ${rowsA.reportId}`,
          () => tx`update public.agent set name = 'probe' where id = ${rowsA.agentId}`,
          () =>
            tx`update public.notification set read_at = now() where id = ${rowsA.notificationId}`,
          () => tx`delete from public.job where id = ${rowsA.jobId}`,
          () => tx`delete from public.runner_execution where id = ${rowsA.runnerExecutionId}`,
          () => tx`delete from public.credential where id = ${rowsA.credentialId}`,
        ])
          await expectZeroOrPermission(tx, operation);
        throw new Error("rollback no-tenant fixture");
      })
      .catch((error) => expect(error.message).toBe("rollback no-tenant fixture"));
  });

  it("allows own mutations and rejects cross-tenant inserts with RLS, while reporting is read-only", async () => {
    await db
      .begin(async (tx) => {
        const run = randomUUID();
        await tx.unsafe("set local role auth_bootstrap");
        const [a] = await tx`select * from public.auth_complete_google_login(
        ${`subject-a-${run}`}, 'a@example.test'::citext, ${sha256(`a-${run}`)}, now() + interval '1 hour', null, null
      )`;
        const [b] = await tx`select * from public.auth_complete_google_login(
        ${`subject-b-${run}`}, 'b@example.test'::citext, ${sha256(`b-${run}`)}, now() + interval '1 hour', null, null
      )`;
        if (!a || !b) throw new Error("auth fixture missing");
        await tx.unsafe("reset role");
        const playbookKey = `rls-${run}`;
        await tx`insert into public.playbook (key, playbook_version, target_category, contract_json)
        values (${playbookKey}, '1.0.0', 'surface', '{}'::jsonb)`;
        const rowsA = await createTenantRows(
          tx,
          a.account_id,
          a.user_id,
          a.session_id,
          `${run}-a`,
          playbookKey,
        );
        const rowsB = await createTenantRows(
          tx,
          b.account_id,
          b.user_id,
          b.session_id,
          `${run}-b`,
          playbookKey,
        );

        for (const role of ["api_rls", "worker_rls", "reporting_rls"]) {
          await tx.unsafe(`set local role ${role}`);
          await tx`select set_config('app.tenant', ${rowsA.accountId}, true)`;
          for (const table of TENANT_TABLES) {
            if (!SELECT_GRANTED[role]?.has(table)) {
              await expectDenied(
                tx,
                () => tx.unsafe(`select id from public."${table}"`),
                /permission denied/,
              );
              continue;
            }
            const rows = await tx.unsafe(
              `select id, ${table === "account" ? "id" : "account_id"} as tenant_id from public."${table}"`,
            );
            expect(rows.length, `${role}/${table} has tenant A row`).toBeGreaterThan(0);
            expect(
              rows.every((row) => row.tenant_id === rowsA.accountId),
              `${role}/${table} tenant`,
            ).toBe(true);
            expect(
              rows.some((row) => row.id === tenantIds(rowsB)[table]),
              `${role}/${table} hides B`,
            ).toBe(false);
          }
        }

        await tx.unsafe("set local role api_rls");
        await tx`select set_config('app.tenant', ${rowsA.accountId}, true)`;
        await expectZeroOrPermissionForEveryTable(tx, rowsB, "update");
        await expectZeroOrPermissionForEveryTable(tx, rowsB, "delete");
        expect(
          (
            await tx`update public.assessment set status = 'queued' where id = ${rowsA.assessmentId}`
          ).count,
        ).toBe(1);
        expect(
          (
            await tx`update public.verification set status = 'verified' where id = ${rowsA.verificationId}`
          ).count,
        ).toBe(1);
        expect(
          (await tx`delete from public.credential where id = ${rowsA.credentialId}`).count,
        ).toBe(1);
        expect((await tx`delete from public.agent where id = ${rowsA.agentId}`).count).toBe(1);

        await tx.unsafe("reset app.tenant");
        for (const operation of [
          () => tx`insert into public.assessment
            (account_id, target_category, target_json, scope_json, playbook_id, playbook_version, limits_json)
            values (${rowsA.accountId}, 'surface', '{}'::jsonb, '{}'::jsonb, ${playbookKey}, '1.0.0', '{}'::jsonb)`,
          () => tx`insert into public.authorization_attestation
            (account_id, assessment_id, user_id, target_json, terms_version)
            values (${rowsA.accountId}, ${rowsA.assessmentId}, ${rowsA.userId}, '{}'::jsonb, ${`insert-${run}`})`,
          () => tx`insert into public.verification
            (account_id, target_json, challenge_token, challenge_host)
            values (${rowsA.accountId}, '{}'::jsonb, ${`insert-${run}`}, 'example.test')`,
          () => tx`insert into public.credential
            (account_id, assessment_id, encrypted_payload, key_id, purpose)
            values (${rowsA.accountId}, ${rowsA.assessmentId}, decode('01', 'hex'), ${`insert-${run}`}, 'fixture')`,
          () => tx`insert into public.audit_event
            (account_id, actor, action, payload_json)
            values (${rowsA.accountId}, ${`insert-${run}`}, 'request', '{}'::jsonb)`,
          () => tx`insert into public.agent
            (account_id, name, token_hash, fingerprint)
            values (${rowsA.accountId}, ${`insert-${run}`}, ${sha256(`insert-agent-${run}`)}, 'fixture')`,
        ])
          await expectDenied(tx, operation, /row-level security/);

        for (const operation of [
          () =>
            tx`update public.account set settings_ia_enabled = false where id = ${rowsB.accountId}`,
          () => tx`update public.assessment set status = 'failed' where id = ${rowsB.assessmentId}`,
          () =>
            tx`update public.verification set status = 'failed' where id = ${rowsB.verificationId}`,
          () => tx`update public.credential set purpose = 'cross' where id = ${rowsB.credentialId}`,
          () => tx`update public.agent set name = 'cross' where id = ${rowsB.agentId}`,
          () =>
            tx`update public.notification set read_at = now() where id = ${rowsB.notificationId}`,
          () => tx`delete from public.credential where id = ${rowsB.credentialId}`,
          () => tx`delete from public.agent where id = ${rowsB.agentId}`,
        ])
          await expectZeroOrPermission(tx, operation);
        await expectDenied(
          tx,
          () => tx`insert into public.assessment
        (id, account_id, target_category, target_json, scope_json, playbook_id, playbook_version, limits_json)
        values (gen_random_uuid(), ${rowsB.accountId}, 'surface', '{}'::jsonb, '{}'::jsonb, ${playbookKey}, '1.0.0', '{}'::jsonb)`,
          /row-level security/,
        );

        await tx.unsafe("set local role worker_rls");
        await tx`select set_config('app.tenant', ${rowsA.accountId}, true)`;
        await expectZeroOrPermissionForEveryTable(tx, rowsB, "update");
        await expectZeroOrPermissionForEveryTable(tx, rowsB, "delete");
        expect(
          (await tx`update public.job set status = 'running' where id = ${rowsA.jobId}`).count,
        ).toBe(1);
        expect(
          (
            await tx`update public.runner_execution set cleaned_up = true where id = ${rowsA.runnerExecutionId}`
          ).count,
        ).toBe(1);
        expect(
          (await tx`update public.finding set title = 'updated' where id = ${rowsA.findingId}`)
            .count,
        ).toBe(1);
        expect(
          (await tx`update public.report set sanitized = true where id = ${rowsA.reportId}`).count,
        ).toBe(1);
        expect(
          (await tx`delete from public.runner_execution where id = ${rowsA.runnerExecutionId}`)
            .count,
        ).toBe(1);

        // Billing mutations are webhook-only. Even with a valid tenant context,
        // worker_rls must not be able to manufacture billing state.
        await expectDenied(
          tx,
          () => tx`insert into public.billing_event
            (account_id, stripe_event_id, type, payload_minimal_json, signature_valid, event_version)
            values (${rowsA.accountId}, ${`fraud-${run}`}, 'fixture', '{}'::jsonb, false, '1')`,
          /permission denied/,
        );
        await expectDenied(
          tx,
          () => tx`insert into public.credit_entry
            (account_id, assessment_id, credits, reason)
            values (${rowsA.accountId}, ${rowsA.assessmentId}, 99, 'forged-webhook')`,
          /permission denied/,
        );
        await expectDenied(
          tx,
          () => tx`insert into public.entitlement
            (account_id, plan, source_event_id)
            values (${rowsA.accountId}, 'pro', ${rowsA.billingEventId})`,
          /permission denied/,
        );

        await tx.unsafe("reset app.tenant");
        for (const operation of [
          () => tx`insert into public.job
            (account_id, assessment_id, playbook_version, job_spec_json, dedupe_key)
            values (${rowsA.accountId}, ${rowsA.assessmentId}, '1.0.0', '{}'::jsonb, ${`insert-${run}`})`,
          () => tx`insert into public.runner_execution
            (account_id, job_id, sandbox_impl)
            values (${rowsA.accountId}, ${rowsA.jobId}, 'fixture')`,
          () => tx`insert into public.finding
            (account_id, assessment_id, title, category, severity)
            values (${rowsA.accountId}, ${rowsA.assessmentId}, ${`insert-${run}`}, 'fixture', 'low')`,
          () => tx`insert into public.report
            (account_id, assessment_id, kind, object_key, contract_version, sanitized)
            values (${rowsA.accountId}, ${rowsA.assessmentId}, 'json', ${`insert-${run}`}, '1', false)`,
          () => tx`insert into public.audit_event
            (account_id, actor, action, payload_json)
            values (${rowsA.accountId}, ${`worker-insert-${run}`}, 'runner', '{}'::jsonb)`,
          () => tx`insert into public.notification
            (account_id, assessment_id, kind)
            values (${rowsA.accountId}, ${rowsA.assessmentId}, ${`insert-${run}`})`,
        ])
          await expectDenied(tx, operation, /row-level security/);

        for (const operation of [
          () => tx`update public.assessment set status = 'failed' where id = ${rowsB.assessmentId}`,
          () =>
            tx`update public.verification set status = 'failed' where id = ${rowsB.verificationId}`,
          () => tx`update public.job set status = 'failed' where id = ${rowsB.jobId}`,
          () =>
            tx`update public.runner_execution set cleaned_up = true where id = ${rowsB.runnerExecutionId}`,
          () => tx`update public.finding set title = 'cross' where id = ${rowsB.findingId}`,
          () => tx`update public.report set sanitized = true where id = ${rowsB.reportId}`,
          () => tx`update public.agent set name = 'cross' where id = ${rowsB.agentId}`,
          () =>
            tx`update public.notification set read_at = now() where id = ${rowsB.notificationId}`,
          () => tx`delete from public.job where id = ${rowsB.jobId}`,
          () => tx`delete from public.runner_execution where id = ${rowsB.runnerExecutionId}`,
          () => tx`delete from public.credential where id = ${rowsB.credentialId}`,
        ])
          await expectZeroOrPermission(tx, operation);
        await expectDenied(
          tx,
          () => tx`insert into public.job
        (id, account_id, assessment_id, playbook_version, job_spec_json, dedupe_key)
        values (gen_random_uuid(), ${rowsB.accountId}, ${rowsB.assessmentId}, '1.0.0', '{}'::jsonb, ${`cross-${run}`})`,
          /row-level security/,
        );

        await tx.unsafe("set local role reporting_rls");
        await tx`select set_config('app.tenant', ${rowsA.accountId}, true)`;
        expect(await tx`select id from public.account`).toHaveLength(1);
        expect(await tx`select id from public.assessment`).toHaveLength(1);
        await tx`select set_config('app.tenant', ${rowsB.accountId}, true)`;
        expect(await tx`select id from public.account where id = ${rowsA.accountId}`).toEqual([]);
        await expectDenied(
          tx,
          () =>
            tx`insert into public.account (status, settings_ia_enabled) values ('active', true)`,
          /permission denied/,
        );
        await expectDenied(
          tx,
          () =>
            tx`update public.account set settings_ia_enabled = false where id = ${rowsB.accountId}`,
          /permission denied/,
        );
        await expectDenied(
          tx,
          () => tx`delete from public.account where id = ${rowsB.accountId}`,
          /permission denied/,
        );
        throw new Error("rollback DML fixture");
      })
      .catch((error) => expect(error.message).toBe("rollback DML fixture"));
  });

  it("keeps playbook read-only and reporting read-only", async () => {
    await db
      .begin(async (tx) => {
        const run = randomUUID();
        await tx.unsafe("set local role auth_bootstrap");
        const [account] = await tx`select * from public.auth_complete_google_login(
        ${`playbook-subject-${run}`}, 'playbook@example.test'::citext, ${sha256(`playbook-${run}`)}, now() + interval '1 hour', null, null
      )`;
        if (!account) throw new Error("playbook fixture missing");
        await tx.unsafe("reset role");
        const playbookKey = `playbook-${run}`;
        await tx`insert into public.playbook (key, playbook_version, target_category, contract_json, active)
        values (${playbookKey}, '1.0.0', 'surface', '{}'::jsonb, true)`;
        await tx.unsafe("set local role api_rls");
        await expectDenied(
          tx,
          () => tx`insert into public.playbook (key, playbook_version, target_category, contract_json, active)
        values (${`forbidden-${run}`}, '1.0.0', 'surface', '{}'::jsonb, true)`,
          /permission denied/,
        );
        await tx.unsafe("set local role reporting_rls");
        await tx`select set_config('app.tenant', ${account.account_id}, true)`;
        await expectDenied(
          tx,
          () => tx`update public.account set status = 'revoked' where id = ${account.account_id}`,
          /permission denied/,
        );
        await expectDenied(
          tx,
          () => tx`delete from public.account where id = ${account.account_id}`,
          /permission denied/,
        );
        throw new Error("rollback fixture");
      })
      .catch((error) => expect(error.message).toBe("rollback fixture"));
  });
});
