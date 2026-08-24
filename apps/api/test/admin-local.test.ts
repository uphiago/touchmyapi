import { describe, expect, it } from "vitest";
import { createLocalAdminApp } from "../src/admin-local";

const origin = "http://127.0.0.1:5174";
const accountId = "00000000-0000-4000-8000-000000000101";

async function bootstrap() {
  const app = createLocalAdminApp({ corsOrigin: origin });
  const session = await app.request("/api/v1/admin/auth/local-session", {
    method: "POST",
    headers: { Origin: origin },
  });
  return { app, cookie: session.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
}

describe("local admin composition", () => {
  it("uses a dedicated cookie and exact credentialed CORS origin", async () => {
    const { app, cookie } = await bootstrap();
    expect(cookie).toMatch(/^tma-admin-session=/);
    const response = await app.request("/api/v1/admin/snapshot", {
      headers: { Cookie: cookie, Origin: origin },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("rejects customer cookies and unconfigured origins", async () => {
    const app = createLocalAdminApp({ corsOrigin: origin });
    expect(
      (
        await app.request("/api/v1/admin/snapshot", {
          headers: { Cookie: `tma-session=${"L".repeat(43)}`, Origin: origin },
        })
      ).status,
    ).toBe(401);
    const foreign = await app.request("/api/v1/admin/auth/local-session", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:5173" },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("requires a distinct approval and a matching active grant", async () => {
    const { app, cookie } = await bootstrap();
    const requested = await app.request("/api/v1/admin/grants", {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        capability: "queue.requeue",
        ticket: "OPS-1234",
        reason: "Recover one reviewed local queue item",
        ttlSeconds: 900,
      }),
    });
    const grant = (await requested.json()) as { grant: { id: string } };
    expect(requested.status).toBe(201);

    const premature = await app.request("/api/v1/admin/queue/actions", {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        grantId: grant.grant.id,
        accountId,
        action: "queue.requeue",
        jobId: "00000000-0000-4000-8000-000000000201",
      }),
    });
    expect(premature.status).toBe(403);

    const selfApproval = await app.request(`/api/v1/admin/grants/${grant.grant.id}/approval`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ approverId: "local-operator", decision: "approved" }),
    });
    expect(selfApproval.status).toBe(409);

    const approved = await app.request(`/api/v1/admin/grants/${grant.grant.id}/approval`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ approverId: "local-approver", decision: "approved" }),
    });
    expect(approved.status).toBe(200);

    const action = await app.request("/api/v1/admin/queue/actions", {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        grantId: grant.grant.id,
        accountId,
        action: "queue.requeue",
        jobId: "00000000-0000-4000-8000-000000000201",
      }),
    });
    expect(action.status).toBe(200);
    expect(await action.json()).toMatchObject({ result: { status: "accepted", simulated: true } });
  });

  it("has no dangerous administrative routes", async () => {
    const { app, cookie } = await bootstrap();
    for (const path of [
      "/api/v1/admin/sql",
      "/api/v1/admin/impersonate",
      "/api/v1/admin/billing/credit",
      "/api/v1/admin/runner/dispatch",
    ]) {
      expect(
        (await app.request(path, { method: "POST", headers: { Cookie: cookie } })).status,
      ).toBe(404);
    }
  });
});
