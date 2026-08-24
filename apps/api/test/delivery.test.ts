import { describe, expect, it, vi } from "vitest";
import { createApp, type ApiDependencies } from "../src/app";
import { createConfig } from "../src/config";
import { hashSessionToken, type AuthSession, type AuthStore } from "../src/auth";
import type { DeliveryStore } from "../src/delivery";

const accountId = "00000000-0000-4000-8000-000000000001";
const assessmentId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const reportId = "00000000-0000-4000-8000-000000000005";
const sessionToken = "D".repeat(43);
const cookie = `__Secure-tma-session=${sessionToken}`;

function fixture(plan: AuthSession["plan"], role = "owner") {
  const session: AuthSession = {
    userId,
    accountId,
    email: "owner@example.test",
    role,
    membershipStatus: "active",
    plan,
    iaEnabled: true,
  };
  const expectedHash = hashSessionToken(sessionToken);
  const authStore: AuthStore = {
    completeGoogleLogin: async () => session,
    resolveSession: async (value) => ((await expectedHash) === value ? session : undefined),
    rotateSession: async () => session,
    revokeSession: async () => undefined,
  };
  const store: DeliveryStore = {
    readAssessment: vi.fn(async ({ visibility }) => ({
      assessmentId,
      status: "completed" as const,
      visibility,
      summary: { total: 1, bySeverity: { low: 1 }, byCategory: { transport: 1 } },
      findings:
        visibility === "aggregate"
          ? []
          : [
              {
                id: "00000000-0000-4000-8000-000000000004",
                title: "HSTS was not observed",
                category: "transport",
                severity: "low" as const,
                ...(visibility === "detailed"
                  ? {
                      endpoint: "https://example.com/",
                      evidence: { strictTransportSecurity: false },
                      reproduction: [],
                      impact: "Reduced transport defense.",
                      remediation: "Enable HSTS.",
                    }
                  : {}),
              },
            ],
    })),
    listNotifications: vi.fn(async () => ({ notifications: [], unreadCount: 0 })),
    markNotificationRead: vi.fn(async () => undefined),
    listReports: vi.fn(async () => ({ reports: [] })),
    createReportDownload: vi.fn(async () => ({
      url: "https://storage.example.test/private?signature=short-lived",
      expiresAt: "2026-08-24T12:01:00.000Z",
    })),
  };
  const dependencies: ApiDependencies = {
    config: createConfig({
      corsOrigin: "https://console.example.test",
      environment: "test",
      port: 3100,
    }),
    logger: { error: () => undefined },
    auditSink: { record: async () => undefined },
    auth: {
      store: authStore,
      transientKey: new Uint8Array(32).fill(1),
      sessionMaxAgeSeconds: 3600,
      transientMaxAgeSeconds: 600,
      successRedirect: "https://console.example.test/",
    },
    delivery: { store, resolveSession: authStore.resolveSession },
  };
  return { app: createApp(dependencies), store };
}

describe("customer delivery API", () => {
  it("forces aggregate delivery for a free unverified account", async () => {
    const { app, store } = fixture("free_unverified");
    const response = await app.request(
      `http://localhost/api/v1/accounts/${accountId}/assessments/${assessmentId}/delivery`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ visibility: "aggregate", findings: [] });
    expect(store.readAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, assessmentId, visibility: "aggregate" }),
    );
  });

  it("allows detailed server-shaped delivery for a paid assessment reader", async () => {
    const { app, store } = fixture("pro", "admin");
    const response = await app.request(
      `http://localhost/api/v1/accounts/${accountId}/assessments/${assessmentId}/delivery`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      visibility: "detailed",
      findings: [{ remediation: "Enable HSTS." }],
    });
    expect(store.readAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "detailed" }),
    );
  });

  it("denies a billing-only member before delivery storage", async () => {
    const { app, store } = fixture("pro", "billing");
    const response = await app.request(
      `http://localhost/api/v1/accounts/${accountId}/assessments/${assessmentId}/delivery`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(403);
    expect(store.readAssessment).not.toHaveBeenCalled();
  });

  it("issues a short-lived private report URL only for a paid assessment reader", async () => {
    const paid = fixture("pro", "owner");
    const paidResponse = await paid.app.request(
      `http://localhost/api/v1/accounts/${accountId}/assessments/${assessmentId}/reports/${reportId}/download`,
      { headers: { Cookie: cookie } },
    );
    expect(paidResponse.status).toBe(200);
    expect(await paidResponse.json()).toMatchObject({
      url: "https://storage.example.test/private?signature=short-lived",
    });
    expect(paid.store.createReportDownload).toHaveBeenCalledWith({
      accountId,
      assessmentId,
      reportId,
    });

    const free = fixture("free_verified", "owner");
    const freeResponse = await free.app.request(
      `http://localhost/api/v1/accounts/${accountId}/assessments/${assessmentId}/reports/${reportId}/download`,
      { headers: { Cookie: cookie } },
    );
    expect(freeResponse.status).toBe(403);
    expect(free.store.createReportDownload).not.toHaveBeenCalled();
  });
});
