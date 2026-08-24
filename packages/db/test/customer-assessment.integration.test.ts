import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAssessment,
  createTenantDatabase,
  listAssessments,
  queueAssessment,
  withTenant,
  type TenantDatabase,
} from "../src";
import {
  createRawDbConnection,
  getRawTenantDatabase,
  type RawDbConnection,
} from "../src/connection-internal";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

function ownerDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for assessment integration tests");
  const parsed = new URL(value);
  if (parsed.hostname !== "127.0.0.1" || !parsed.pathname.endsWith("_test")) {
    throw new Error("Assessment tests require a loopback *_test database");
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describeDb("customer assessment PostgreSQL capability", () => {
  let owner!: RawDbConnection;
  let tenant!: TenantDatabase;
  let connectorRole = "";
  let accountId = "";
  let userId = "";

  beforeAll(async () => {
    const ownerUrl = ownerDatabaseUrl();
    owner = createRawDbConnection(ownerUrl);
    connectorRole = `tma_assessment_${randomUUID().replaceAll("-", "")}`;
    const password = randomUUID().replaceAll("-", "");
    await owner.unsafe(
      `create role ${quoteIdentifier(connectorRole)} login noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password '${password}'`,
    );
    await owner.unsafe(`grant api_rls to ${quoteIdentifier(connectorRole)}`);
    const sessionHash = createHash("sha256").update(randomUUID()).digest("hex");
    const [login] = await owner`
      select * from public.auth_complete_provider_login(
        'github'::public.identity_provider,
        ${`assessment-${randomUUID()}`},
        'assessment@example.test'::public.citext,
        ${sessionHash},
        now() + interval '1 hour',
        '127.0.0.1'::inet,
        'assessment-integration'
      )
    `;
    accountId = String(login?.account_id);
    userId = String(login?.user_id);
    const connectorUrl = new URL(ownerUrl);
    connectorUrl.username = connectorRole;
    connectorUrl.password = password;
    tenant = createTenantDatabase(connectorUrl.toString());
  });

  afterAll(async () => {
    if (tenant) await getRawTenantDatabase(tenant).end();
    if (owner && accountId) {
      await owner.begin(async (tx) => {
        await tx`delete from public.outbox_event where account_id = ${accountId}`;
        await tx`delete from public.job where account_id = ${accountId}`;
        await tx`delete from public.authorization_attestation where account_id = ${accountId}`;
        await tx`delete from public.assessment where account_id = ${accountId}`;
        await tx`delete from public.session where account_id = ${accountId}`;
        await tx`delete from public.audit_event where account_id = ${accountId}`;
        await tx`delete from public.audit_account_state where account_id = ${accountId}`;
        await tx`delete from public.account_membership where account_id = ${accountId}`;
        await tx`delete from public.queue_tenant_state where account_id = ${accountId}`;
        await tx`delete from public."user" where account_id = ${accountId}`;
        await tx`delete from public.account where id = ${accountId}`;
      });
    }
    if (owner && connectorRole) {
      await owner.unsafe(`drop role if exists ${quoteIdentifier(connectorRole)}`);
    }
    await owner?.end();
  });

  it("creates a draft and authorization attestation atomically, then lists it", async () => {
    const created = await withTenant(tenant, accountId, "api_rls", (context) =>
      createAssessment(context, {
        userId,
        request: {
          targetCategory: "surface",
          target: "example.test",
          scope: ["example.test"],
          playbookId: "surface-public-posture",
          authorization: { accepted: true, termsVersion: "terms@1" },
        },
      }),
    );

    expect(created).toMatchObject({
      accountId,
      targetCategory: "surface",
      target: "example.test",
      scope: ["example.test"],
      playbookId: "surface-public-posture",
      playbookVersion: "1.0.0",
      status: "draft",
      jobId: null,
    });
    const [attestation] = await owner`
      select user_id, terms_version, target_json
      from public.authorization_attestation where assessment_id = ${created.id}
    `;
    expect(attestation).toMatchObject({
      user_id: userId,
      terms_version: "terms@1",
    });
    expect(JSON.parse(String(attestation?.target_json))).toEqual({ value: "example.test" });
    expect(await withTenant(tenant, accountId, "api_rls", listAssessments)).toEqual([created]);
  });

  it("queues only an attested passive draft through the durable queue", async () => {
    const [draft] = await withTenant(tenant, accountId, "api_rls", listAssessments);
    if (!draft) throw new Error("draft fixture missing");
    const queued = await withTenant(tenant, accountId, "api_rls", (context) =>
      queueAssessment(context, { assessmentId: draft.id }),
    );
    const jobId = queued?.jobId;
    expect(queued).toMatchObject({ id: draft.id, status: "queued", jobId: expect.any(String) });
    if (!jobId) throw new Error("queued job missing");
    const [job] = await owner`
      select status, normalized_target_key from public.job where id = ${jobId}
    `;
    expect(job).toEqual({ status: "queued", normalized_target_key: "example.test" });
  });
});
