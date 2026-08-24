import {
  assessmentDeliveryResponseSchema,
  notificationListResponseSchema,
  reportListResponseSchema,
  reportDownloadResponseSchema,
  type AssessmentDeliveryResponse,
} from "@touchmyapi/contracts";
import {
  appendAuditEvent,
  listTenantNotifications,
  listTenantReports,
  markTenantNotificationRead,
  readTenantAssessmentDelivery,
  readTenantReportObjectKey,
  withTenant,
  type TenantDatabase,
} from "@touchmyapi/db";
import type { Visibility } from "@touchmyapi/policy";
import { ReportStorageUnavailableError, type DeliveryStore } from "./delivery";
import type { PrivateReportStorage } from "@touchmyapi/reporting";

function summary(findings: readonly { severity: string; category: string }[]) {
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
  }
  return { total: findings.length, bySeverity, byCategory };
}

function shapeDelivery(
  delivery: NonNullable<Awaited<ReturnType<typeof readTenantAssessmentDelivery>>>,
  visibility: Visibility,
): AssessmentDeliveryResponse {
  const common = {
    assessmentId: delivery.assessmentId,
    status: delivery.status,
    summary: summary(delivery.findings),
  };
  if (visibility === "aggregate") {
    return assessmentDeliveryResponseSchema.parse({
      ...common,
      visibility,
      findings: [],
    });
  }
  if (visibility === "masked") {
    return assessmentDeliveryResponseSchema.parse({
      ...common,
      visibility,
      findings: delivery.findings.map(({ id, title, category, severity }) => ({
        id,
        title,
        category,
        severity,
      })),
    });
  }
  return assessmentDeliveryResponseSchema.parse({
    ...common,
    visibility,
    findings: delivery.findings,
  });
}

export function createPostgresDeliveryStore(
  database: TenantDatabase,
  reportStorage?: PrivateReportStorage,
): DeliveryStore {
  return {
    readAssessment: ({ accountId, assessmentId, visibility }) =>
      withTenant(database, accountId, "api_rls", async (context) => {
        const delivery = await readTenantAssessmentDelivery(context, assessmentId);
        return delivery ? shapeDelivery(delivery, visibility) : undefined;
      }),
    listNotifications: ({ accountId }) =>
      withTenant(database, accountId, "api_rls", async (context) => {
        const notifications = await listTenantNotifications(context);
        return notificationListResponseSchema.parse({
          notifications,
          unreadCount: notifications.filter((item) => item.readAt === null).length,
        });
      }),
    markNotificationRead: ({ accountId, notificationId }) =>
      withTenant(database, accountId, "api_rls", (context) =>
        markTenantNotificationRead(context, notificationId),
      ),
    listReports: ({ accountId, assessmentId, allowed }) => {
      if (!allowed) return Promise.resolve(reportListResponseSchema.parse({ reports: [] }));
      return withTenant(database, accountId, "api_rls", async (context) =>
        reportListResponseSchema.parse({
          reports: await listTenantReports(context, assessmentId),
        }),
      );
    },
    createReportDownload: async ({ accountId, assessmentId, reportId }) => {
      if (!reportStorage) throw new ReportStorageUnavailableError();
      return withTenant(database, accountId, "api_rls", async (context) => {
        const report = await readTenantReportObjectKey(context, assessmentId, reportId);
        if (!report) return undefined;
        const expiresInSeconds = 60;
        const url = await reportStorage.createDownloadUrl(report.objectKey, expiresInSeconds);
        await appendAuditEvent(context, {
          actor: "customer_api",
          action: "download",
          assessmentId,
          payload: { event: "report_download_issued", reportId, kind: report.kind },
        });
        return reportDownloadResponseSchema.parse({
          url,
          expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
        });
      });
    },
  };
}
