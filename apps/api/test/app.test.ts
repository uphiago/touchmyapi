import { describe, expect, it } from "vitest";
import {
  app as defaultApp,
  createApp,
  type AuditRecord,
  type AuditSink,
  type ApiLogger,
} from "../src/app";
import { createConfig } from "../src/config";
import { ApiError } from "../src/error";

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

  it("audits auth CORS preflight exactly once", async () => {
    const records: AuditRecord[] = [];
    const app = createTestApp({
      record: async (record) => {
        records.push(record);
      },
    });
    const response = await app.request("http://localhost/api/v1/auth/future", {
      method: "OPTIONS",
      headers: {
        Origin: config.corsOrigin,
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(config.corsOrigin);
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toEqual({ method: "OPTIONS", route: "api.v1" });
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
    expect(records[0]?.payload).toEqual({ method: "GET", route: "api.v1" });
  });

  it("uses server-owned request IDs and never persists secret-bearing paths", async () => {
    const records: AuditRecord[] = [];
    const app = createTestApp({
      record: async (record) => {
        records.push(record);
      },
    });
    const response = await app.request("http://localhost/api/v1/unknown/password-reset-token", {
      headers: { "x-request-id": "attacker-request-id" },
    });

    expect(response.headers.get("x-request-id")).not.toBe("attacker-request-id");
    expect(response.headers.get("x-request-id")).toBe(records[0]?.requestId);
    expect(JSON.stringify(records[0]?.payload)).not.toContain("password-reset-token");
    expect(records[0]?.payload).toEqual({ method: "GET", route: "api.v1" });
  });

  it("fails closed for mutations when the audit sink is unavailable", async () => {
    let executed = false;
    const app = createTestApp({
      record: async () => {
        throw new Error("audit secret should not escape");
      },
    });
    app.post("/api/v1/mutation", () => {
      executed = true;
      return new Response("must not execute");
    });
    const response = await app.request("http://localhost/api/v1/mutation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "do-not-record" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "audit_unavailable", message: "Service Unavailable" },
    });
    expect(executed).toBe(false);
  });

  it("maps typed API errors to their stable status envelope", async () => {
    const app = createTestApp({ record: async () => undefined });
    app.get("/api/v1/conflict", () => {
      throw new ApiError(409, "conflict", "Conflict", "target");
    });

    const response = await app.request("http://localhost/api/v1/conflict");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "conflict", message: "Conflict", field: "target" },
    });
  });

  it("does not run with a silent default audit sink", async () => {
    expect((await defaultApp.request("http://localhost/health")).status).toBe(200);
    expect(
      (await defaultApp.request("http://localhost/api/v1/mutation", { method: "POST" })).status,
    ).toBe(503);
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
