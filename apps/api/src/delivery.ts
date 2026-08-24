import {
  assessmentDeliveryResponseSchema,
  notificationListResponseSchema,
  notificationSchema,
  reportListResponseSchema,
  reportDownloadResponseSchema,
  type AssessmentDeliveryResponse,
  type Notification,
  type NotificationListResponse,
  type ReportListResponse,
  type ReportDownloadResponse,
} from "@touchmyapi/contracts";
import {
  canMembershipCapability,
  evaluateMembership,
  isPlan,
  rightsForPlan,
  type MembershipCapability,
  type Visibility,
} from "@touchmyapi/policy";
import type { Context, Hono } from "hono";
import type { ApiEnvironment } from "./config";
import { ApiError } from "./error";
import { hashSessionToken, readSessionToken, type AuthStore } from "./auth";
import type { ApiRequestEnv } from "./request-id";

export type DeliveryStore = Readonly<{
  readAssessment: (input: {
    accountId: string;
    assessmentId: string;
    visibility: Visibility;
  }) => Promise<AssessmentDeliveryResponse | undefined>;
  listNotifications: (input: { accountId: string }) => Promise<NotificationListResponse>;
  markNotificationRead: (input: {
    accountId: string;
    notificationId: string;
  }) => Promise<Notification | undefined>;
  listReports: (input: {
    accountId: string;
    assessmentId: string;
    allowed: boolean;
  }) => Promise<ReportListResponse>;
  createReportDownload: (input: {
    accountId: string;
    assessmentId: string;
    reportId: string;
  }) => Promise<ReportDownloadResponse | undefined>;
}>;

export type DeliveryDependencies = Readonly<{
  store: DeliveryStore;
  resolveSession: AuthStore["resolveSession"];
  allowInsecureCookies?: boolean;
}>;

export class ReportStorageUnavailableError extends Error {
  constructor() {
    super("report_storage_unavailable");
    this.name = "ReportStorageUnavailableError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function identifier(context: Context<ApiRequestEnv>, name: string): string {
  const value = context.req.param(name);
  if (!value || !UUID.test(value))
    throw new ApiError(400, "invalid_identifier", "Invalid identifier");
  return value.toLowerCase();
}

async function activeSession(
  context: Context<ApiRequestEnv>,
  dependencies: DeliveryDependencies,
  accountId: string,
  environment: ApiEnvironment,
) {
  const cookieName =
    dependencies.allowInsecureCookies === true && environment === "development"
      ? "tma-session"
      : "__Secure-tma-session";
  const token = readSessionToken(context.req.raw, cookieName);
  if (!token) throw new ApiError(401, "unauthorized", "Authentication required");
  const session = await dependencies.resolveSession(await hashSessionToken(token));
  if (!session || session.accountId !== accountId) {
    throw new ApiError(403, "active_account_required", "Active account required");
  }
  return session;
}

function requireCapability(
  session: NonNullable<Awaited<ReturnType<AuthStore["resolveSession"]>>>,
  capability: MembershipCapability,
): void {
  try {
    const membership = evaluateMembership({
      accountId: session.accountId,
      userId: session.userId,
      role: session.role as Parameters<typeof evaluateMembership>[0]["role"],
      status: session.membershipStatus,
    });
    if (canMembershipCapability(membership, capability)) return;
  } catch {
    // Invalid server-owned facts fail closed.
  }
  throw new ApiError(403, "membership_required", "Membership capability required");
}

function rights(session: NonNullable<Awaited<ReturnType<AuthStore["resolveSession"]>>>) {
  return rightsForPlan(isPlan(session.plan) ? session.plan : "free_unverified");
}

export function registerDeliveryRoutes(
  api: Hono<ApiRequestEnv>,
  dependencies: DeliveryDependencies,
  environment: ApiEnvironment = "production",
): void {
  api.get("/api/v1/accounts/:accountId/assessments/:assessmentId/delivery", async (context) => {
    const accountId = identifier(context, "accountId");
    const assessmentId = identifier(context, "assessmentId");
    const session = await activeSession(context, dependencies, accountId, environment);
    requireCapability(session, "assessment:read");
    const result = await dependencies.store.readAssessment({
      accountId,
      assessmentId,
      visibility: rights(session).visibility,
    });
    if (!result) throw new ApiError(404, "assessment_not_found", "Assessment not found");
    return context.json(assessmentDeliveryResponseSchema.parse(result));
  });

  api.get("/api/v1/accounts/:accountId/notifications", async (context) => {
    const accountId = identifier(context, "accountId");
    const session = await activeSession(context, dependencies, accountId, environment);
    requireCapability(session, "account:read");
    return context.json(
      notificationListResponseSchema.parse(
        await dependencies.store.listNotifications({ accountId }),
      ),
    );
  });

  api.post("/api/v1/accounts/:accountId/notifications/:notificationId/read", async (context) => {
    const accountId = identifier(context, "accountId");
    const notificationId = identifier(context, "notificationId");
    const session = await activeSession(context, dependencies, accountId, environment);
    requireCapability(session, "account:read");
    const result = await dependencies.store.markNotificationRead({ accountId, notificationId });
    if (!result) throw new ApiError(404, "notification_not_found", "Notification not found");
    return context.json({ notification: notificationSchema.parse(result) });
  });

  api.get("/api/v1/accounts/:accountId/assessments/:assessmentId/reports", async (context) => {
    const accountId = identifier(context, "accountId");
    const assessmentId = identifier(context, "assessmentId");
    const session = await activeSession(context, dependencies, accountId, environment);
    requireCapability(session, "assessment:read");
    return context.json(
      reportListResponseSchema.parse(
        await dependencies.store.listReports({
          accountId,
          assessmentId,
          allowed: rights(session).reports,
        }),
      ),
    );
  });

  api.get(
    "/api/v1/accounts/:accountId/assessments/:assessmentId/reports/:reportId/download",
    async (context) => {
      const accountId = identifier(context, "accountId");
      const assessmentId = identifier(context, "assessmentId");
      const reportId = identifier(context, "reportId");
      const session = await activeSession(context, dependencies, accountId, environment);
      requireCapability(session, "assessment:read");
      if (!rights(session).reports) {
        throw new ApiError(403, "plan_required", "An eligible plan is required");
      }
      let result: ReportDownloadResponse | undefined;
      try {
        result = await dependencies.store.createReportDownload({
          accountId,
          assessmentId,
          reportId,
        });
      } catch (error) {
        if (error instanceof ReportStorageUnavailableError) {
          throw new ApiError(503, "report_storage_unavailable", "Report storage unavailable");
        }
        throw error;
      }
      if (!result) throw new ApiError(404, "report_not_found", "Report not found");
      return context.json(reportDownloadResponseSchema.parse(result));
    },
  );
}
