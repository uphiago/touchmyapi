import { describe, expect, it } from "vitest";
import { createApp, type AuditRecord, type AuditSink, type ApiLogger } from "../src/app";
import { createConfig } from "../src/config";

const config = createConfig({
  corsOrigin: "https://console.example.test",
  environment: "test",
  port: 3100,
});

const logger: ApiLogger = {
  error: () => undefined,
};

const createTestApp = (auditSink: AuditSink) => createApp({ config, logger, auditSink });

describe("API boundary", () => {
  it("keeps health public and returns request IDs", async () => {
    const app = createTestApp({ record: async () => undefined });
    const response = await app.request("http://localhost/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns a stable not-found envelope with a request ID", async () => {
    const app = createTestApp({ record: async () => undefined });
    const response = await app.request("http://localhost/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Not Found" },
    });
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("allows only the configured origin and credentials on auth paths", async () => {
    const app = createTestApp({ record: async () => undefined });
    const allowedHealth = await app.request("http://localhost/health", {
      headers: { Origin: config.corsOrigin },
    });
    const allowedAuth = await app.request("http://localhost/api/v1/auth/future", {
      headers: { Origin: config.corsOrigin },
    });
    const disallowed = await app.request("http://localhost/health", {
      headers: { Origin: "https://evil.example.test" },
    });

    expect(allowedHealth.headers.get("access-control-allow-origin")).toBe(config.corsOrigin);
    expect(allowedHealth.headers.get("access-control-allow-credentials")).toBeNull();
    expect(allowedAuth.headers.get("access-control-allow-origin")).toBe(config.corsOrigin);
    expect(allowedAuth.headers.get("access-control-allow-credentials")).toBe("true");
    expect(disallowed.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("audits API requests with a redaction-safe payload", async () => {
    const records: AuditRecord[] = [];
    const app = createTestApp({
      record: async (record) => {
        records.push(record);
      },
    });
    const response = await app.request("http://localhost/api/v1/unknown", {
      headers: {
        Authorization: "Bearer do-not-record",
        Cookie: "session=do-not-record",
      },
    });

    expect(response.status).toBe(404);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ action: "request" });
    expect(records[0]?.requestId).toBe(response.headers.get("x-request-id"));
    expect(JSON.stringify(records[0]?.payload)).not.toContain("do-not-record");
    expect(records[0]?.payload).toEqual({ method: "GET", path: "/api/v1/unknown" });
  });

  it("fails closed for mutations when the audit sink is unavailable", async () => {
    const app = createTestApp({
      record: async () => {
        throw new Error("audit secret should not escape");
      },
    });
    const response = await app.request("http://localhost/api/v1/assessments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "do-not-record" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "audit_unavailable", message: "Service Unavailable" },
    });
  });

  it("maps unexpected route errors without exposing stack or details", async () => {
    const app = createTestApp({ record: async () => undefined });
    app.get("/api/v1/test-error", () => {
      throw new Error("private stack detail");
    });

    const response = await app.request("http://localhost/api/v1/test-error");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toBe(
      JSON.stringify({ error: { code: "internal_error", message: "Internal Server Error" } }),
    );
    expect(body).not.toContain("private stack detail");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("does not expose assessment or execution routes", async () => {
    const app = createTestApp({ record: async () => undefined });
    for (const path of ["/api/v1/assessments", "/api/v1/jobs", "/api/v1/run"]) {
      expect((await app.request(`http://localhost${path}`)).status).toBe(404);
    }
  });
});
