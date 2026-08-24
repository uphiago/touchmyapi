import {
  accountListResponseSchema,
  accountMutationResponseSchema,
  accountSwitchRequestSchema,
  authProvidersResponseSchema,
  authSessionResponseSchema,
  errorResponseSchema,
  invitationCreateResponseSchema,
  invitationCreateSchema,
  invitationAcceptRequestSchema,
  membershipListResponseSchema,
  membershipMutationResponseSchema,
  membershipUpdateSchema,
  type AccountListResponse,
  type AccountMutationResponse,
  type AuthProvidersResponse,
  type AuthSessionResponse,
  assessmentCreateSchema,
  assessmentListResponseSchema,
  assessmentMutationResponseSchema,
  type Assessment,
  type AssessmentCreate,
  type InvitationCreate,
  type InvitationCreateResponse,
  type MembershipListResponse,
  type MembershipMutationResponse,
  type MembershipUpdate,
  assessmentDeliveryResponseSchema,
  notificationListResponseSchema,
  notificationSchema,
  reportListResponseSchema,
  reportDownloadResponseSchema,
  type AssessmentDeliveryResponse,
  type NotificationListResponse,
  type ReportListResponse,
  type ReportDownloadResponse,
} from "../contracts/src";

const notificationMutationResponseSchema = {
  parse(value: unknown) {
    if (!value || typeof value !== "object" || !("notification" in value)) {
      throw new TypeError("Invalid notification response");
    }
    return { notification: notificationSchema.parse(value.notification) };
  },
};

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

export type ApiClient = Readonly<{
  getAuthProviders: () => Promise<AuthProvidersResponse>;
  getSession: () => Promise<AuthSessionResponse>;
  logout: () => Promise<void>;
  listAccounts: () => Promise<AccountListResponse>;
  switchAccount: (accountId: string) => Promise<AccountMutationResponse>;
  listMemberships: (accountId: string) => Promise<MembershipListResponse>;
  createInvitation: (
    accountId: string,
    input: InvitationCreate,
  ) => Promise<InvitationCreateResponse>;
  updateMembership: (
    accountId: string,
    userId: string,
    input: MembershipUpdate,
  ) => Promise<MembershipMutationResponse>;
  removeMembership: (accountId: string, userId: string) => Promise<MembershipMutationResponse>;
  acceptInvitation: (token: string) => Promise<AccountMutationResponse>;
  listAssessments: (accountId: string) => Promise<{ assessments: readonly Assessment[] }>;
  createAssessment: (
    accountId: string,
    input: AssessmentCreate,
  ) => Promise<{ assessment: Assessment }>;
  queueAssessment: (accountId: string, assessmentId: string) => Promise<{ assessment: Assessment }>;
  getAssessmentDelivery: (
    accountId: string,
    assessmentId: string,
  ) => Promise<AssessmentDeliveryResponse>;
  listNotifications: (accountId: string) => Promise<NotificationListResponse>;
  markNotificationRead: (
    accountId: string,
    notificationId: string,
  ) => Promise<NotificationListResponse["notifications"][number]>;
  listReports: (accountId: string, assessmentId: string) => Promise<ReportListResponse>;
  createReportDownload: (
    accountId: string,
    assessmentId: string,
    reportId: string,
  ) => Promise<ReportDownloadResponse>;
}>;

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

async function parseError(response: Response): Promise<ApiClientError> {
  try {
    const parsed = errorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return new ApiClientError(response.status, parsed.data.error.code, parsed.data.error.message);
    }
  } catch {
    // Use the stable fallback below when the response is not JSON.
  }
  return new ApiClientError(response.status, "api_error", "The request could not be completed");
}

async function requestJson<T>(
  fetcher: Fetcher,
  url: string,
  schema: { parse: (value: unknown) => T },
  init: RequestInit = {},
): Promise<T> {
  const response = await fetcher(url, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) throw await parseError(response);
  return schema.parse(await response.json());
}

export function createApiClient(baseUrl: string, fetcher: Fetcher = fetch): ApiClient {
  return {
    getAuthProviders: () =>
      requestJson(fetcher, joinUrl(baseUrl, "/api/v1/auth/providers"), authProvidersResponseSchema),
    getSession: () =>
      requestJson(fetcher, joinUrl(baseUrl, "/api/v1/auth/session"), authSessionResponseSchema),
    logout: async () => {
      const response = await fetcher(joinUrl(baseUrl, "/api/v1/auth/logout"), {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw await parseError(response);
    },
    listAccounts: () =>
      requestJson(fetcher, joinUrl(baseUrl, "/api/v1/accounts"), accountListResponseSchema),
    switchAccount: (accountId) => {
      const body = accountSwitchRequestSchema.parse({ accountId });
      return requestJson(
        fetcher,
        joinUrl(baseUrl, "/api/v1/account/switch"),
        accountMutationResponseSchema,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    listMemberships: (accountId) =>
      requestJson(
        fetcher,
        joinUrl(baseUrl, `/api/v1/accounts/${encodeURIComponent(accountId)}/memberships`),
        membershipListResponseSchema,
      ),
    createInvitation: (accountId, input) => {
      const body = invitationCreateSchema.parse(input);
      return requestJson(
        fetcher,
        joinUrl(
          baseUrl,
          `/api/v1/accounts/${encodeURIComponent(accountId)}/memberships/invitations`,
        ),
        invitationCreateResponseSchema,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    updateMembership: (accountId, userId, input) => {
      const body = membershipUpdateSchema.parse(input);
      return requestJson(
        fetcher,
        joinUrl(
          baseUrl,
          `/api/v1/accounts/${encodeURIComponent(accountId)}/memberships/${encodeURIComponent(userId)}`,
        ),
        membershipMutationResponseSchema,
        { method: "PATCH", body: JSON.stringify(body) },
      );
    },
    removeMembership: (accountId, userId) =>
      requestJson(
        fetcher,
        joinUrl(
          baseUrl,
          `/api/v1/accounts/${encodeURIComponent(accountId)}/memberships/${encodeURIComponent(userId)}`,
        ),
        membershipMutationResponseSchema,
        { method: "DELETE" },
      ),
    acceptInvitation: (token) => {
      const body = invitationAcceptRequestSchema.parse({ token });
      return requestJson(
        fetcher,
        joinUrl(baseUrl, "/api/v1/invitations/accept"),
        accountMutationResponseSchema,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    listAssessments: (accountId) =>
      requestJson(
        fetcher,
        joinUrl(baseUrl, `/api/v1/accounts/${encodeURIComponent(accountId)}/assessments`),
        assessmentListResponseSchema,
      ),
    createAssessment: (accountId, input) => {
      const body = assessmentCreateSchema.parse(input);
      return requestJson(
        fetcher,
        joinUrl(baseUrl, `/api/v1/accounts/${encodeURIComponent(accountId)}/assessments`),
        assessmentMutationResponseSchema,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    queueAssessment: (accountId, assessmentId) =>
      requestJson(
        fetcher,
        joinUrl(
          baseUrl,
          `/api/v1/accounts/${encodeURIComponent(accountId)}/assessments/${encodeURIComponent(assessmentId)}/queue`,
        ),
        assessmentMutationResponseSchema,
        { method: "POST" },
      ),
    getAssessmentDelivery: (accountId, assessmentId) =>
      requestJson(
        fetcher,
        joinUrl(
          baseUrl,
          `/api/v1/accounts/${encodeURIComponent(accountId)}/assessments/${encodeURIComponent(assessmentId)}/delivery`,
        ),
        assessmentDeliveryResponseSchema,
      ),
    listNotifications: (accountId) =>
      requestJson(
        fetcher,
        joinUrl(baseUrl, `/api/v1/accounts/${encodeURIComponent(accountId)}/notifications`),
        notificationListResponseSchema,
      ),
    markNotificationRead: (accountId, notificationId) =>
      requestJson(
        fetcher,
        joinUrl(
          baseUrl,
          `/api/v1/accounts/${encodeURIComponent(accountId)}/notifications/${encodeURIComponent(notificationId)}/read`,
        ),
        notificationMutationResponseSchema,
      ).then((response) => response.notification),
    listReports: (accountId, assessmentId) =>
      requestJson(
        fetcher,
        joinUrl(
          baseUrl,
          `/api/v1/accounts/${encodeURIComponent(accountId)}/assessments/${encodeURIComponent(assessmentId)}/reports`,
        ),
        reportListResponseSchema,
      ),
    createReportDownload: (accountId, assessmentId, reportId) =>
      requestJson(
        fetcher,
        joinUrl(
          baseUrl,
          `/api/v1/accounts/${encodeURIComponent(accountId)}/assessments/${encodeURIComponent(assessmentId)}/reports/${encodeURIComponent(reportId)}/download`,
        ),
        reportDownloadResponseSchema,
      ),
  };
}
