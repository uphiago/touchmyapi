import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTenantDatabase,
  createRawDbConnection,
  createTenantDatabase,
  type RawDbConnection,
  type TenantDatabase,
} from "../src/connection-internal";
import {
  listTenantNotifications,
  listTenantReports,
  markTenantNotificationRead,
  readTenantAssessmentDelivery,
} from "../src/tenant-delivery";
import { withTenant } from "../src/tenant-session";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const connectorPassword = "api-delivery-test-secret";

function databaseUrlForTest(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for tenant delivery tests");
  const parsed = new URL(value);
  if (
    !/^(127\.0\.0\.1|localhost)$/u.test(parsed.hostname) ||
    !parsed.pathname.slice(1).endsWith("_test")
  ) {
    throw new Error("Tenant delivery tests require a loopback *_test database");
  }
  return value;
}

function apiUrl(ownerUrl: string): string {
  const parsed = new URL(ownerUrl);
  parsed.username = "api_connector";
  parsed.password = connectorPassword;
  return parsed.toString();
}

describe.skipIf(!RUN_DB_TESTS)("tenant delivery isolation", () => {
  let owner!: RawDbConnection;
  let api!: TenantDatabase;

  beforeAll(async () => {
    const url = databaseUrlForTest();
    owner = createRawDbConnection(url);
    await owner.unsafe(`alter role api_connector password '${connectorPassword}'`);
    api = createTenantDatabase(apiUrl(url));
  });

  afterAll(async () => {
    if (api) await closeTenantDatabase(api);
    if (owner) await owner.end();
  });

  it("returns published data only inside the active account and marks reads idempotently", async () => {
    const accountId = crypto.randomUUID();
    const foreignAccountId = crypto.randomUUID();
    const assessmentId = crypto.randomUUID();
    const foreignAssessmentId = crypto.randomUUID();
    const notificationId = crypto.randomUUID();
    const playbookKey = `tenant-delivery-${assessmentId}`;
    try {
      await owner.unsafe("insert into public.account (id) values ($1::uuid), ($2::uuid)", [
        accountId,
        foreignAccountId,
      ]);
      await owner.unsafe(
        `insert into public.playbook (key, playbook_version, target_category, contract_json)
         values ($1, '1.0.0', 'surface', '{"actions":[]}'::jsonb)`,
        [playbookKey],
      );
      await owner.unsafe(
        `insert into public.assessment (
           id, account_id, target_category, target_json, scope_json, playbook_id,
           playbook_version, limits_json, status
         ) values
           ($1::uuid, $2::uuid, 'surface', '{}', '[]', $5, '1.0.0', '{}', 'completed'),
           ($3::uuid, $4::uuid, 'surface', '{}', '[]', $5, '1.0.0', '{}', 'completed')`,
        [assessmentId, accountId, foreignAssessmentId, foreignAccountId, playbookKey],
      );
      await owner.unsafe(
        `insert into public.finding (
           account_id, assessment_id, source_key, title, category, severity,
           endpoint, evidence_json, repro, impact, remediation, published
         ) values (
           $1::uuid, $2::uuid, 'tls:expiry', 'Certificate expires soon', 'transport', 'low',
           'https://example.com', '{"daysRemaining":7}', '["Inspect certificate"]',
           'Renewal risk', 'Renew certificate', true
         )`,
        [accountId, assessmentId],
      );
      await owner.unsafe(
        `insert into public.notification (id, account_id, assessment_id, event_key, kind)
         values ($1::uuid, $2::uuid, $3::uuid, $4, 'assessment_completed')`,
        [notificationId, accountId, assessmentId, `assessment:${assessmentId}:completed`],
      );
      await owner.unsafe(
        `insert into public.report (
           account_id, assessment_id, kind, object_key, contract_version, sanitized
         ) values ($1::uuid, $2::uuid, 'json', $3, 'report@1', true)`,
        [accountId, assessmentId, `accounts/${accountId}/assessments/${assessmentId}/report.json`],
      );

      const own = await withTenant(api, accountId, "api_rls", async (context) => ({
        delivery: await readTenantAssessmentDelivery(context, assessmentId),
        notifications: await listTenantNotifications(context),
        reports: await listTenantReports(context, assessmentId),
      }));
      expect(own.delivery).toMatchObject({ assessmentId, status: "completed" });
      expect(own.delivery?.findings).toHaveLength(1);
      expect(own.notifications).toHaveLength(1);
      expect(own.reports).toHaveLength(1);

      const foreign = await withTenant(api, foreignAccountId, "api_rls", async (context) => ({
        delivery: await readTenantAssessmentDelivery(context, assessmentId),
        notifications: await listTenantNotifications(context),
        reports: await listTenantReports(context, assessmentId),
        marked: await markTenantNotificationRead(context, notificationId),
      }));
      expect(foreign).toEqual({
        delivery: undefined,
        notifications: [],
        reports: [],
        marked: undefined,
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const marked = await withTenant(api, accountId, "api_rls", (context) =>
          markTenantNotificationRead(context, notificationId),
        );
        expect(marked?.readAt).toBeTruthy();
      }
    } finally {
      await owner.unsafe("delete from public.report where assessment_id = $1::uuid", [
        assessmentId,
      ]);
      await owner.unsafe("delete from public.notification where assessment_id = $1::uuid", [
        assessmentId,
      ]);
      await owner.unsafe("delete from public.finding where assessment_id = $1::uuid", [
        assessmentId,
      ]);
      await owner.unsafe("delete from public.assessment where id in ($1::uuid, $2::uuid)", [
        assessmentId,
        foreignAssessmentId,
      ]);
      await owner.unsafe("delete from public.playbook where key = $1", [playbookKey]);
      await owner.unsafe(
        "delete from public.queue_tenant_state where account_id in ($1::uuid, $2::uuid)",
        [accountId, foreignAccountId],
      );
      await owner.unsafe("delete from public.account where id in ($1::uuid, $2::uuid)", [
        accountId,
        foreignAccountId,
      ]);
    }
  });
});
