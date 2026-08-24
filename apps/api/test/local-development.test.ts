import { describe, expect, it } from "vitest";
import { createLocalDevelopmentApp } from "../src/local-development";
import { createConfig } from "../src/config";

const origin = "http://localhost:5173";
const accountId = "00000000-0000-4000-8000-000000000101";
const secondAccountId = "00000000-0000-4000-8000-000000000102";

describe("local development composition", () => {
  it("bootstraps a mock session and exercises account switch plus memberships", async () => {
    const app = createLocalDevelopmentApp(
      createConfig({ corsOrigin: origin, environment: "development", port: 3000 }),
    );
    const sessionResponse = await app.request("http://localhost/api/v1/auth/local-session", {
      headers: { Origin: origin },
    });
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];

    expect(sessionResponse.status).toBe(200);
    expect(cookie).toMatch(/^tma-session=L+$/);
    if (!cookie) throw new Error("local session cookie missing");

    const accounts = await app.request("http://localhost/api/v1/accounts", {
      headers: { Cookie: cookie, Origin: origin },
    });
    expect(await accounts.json()).toEqual({
      accounts: [
        {
          accountId,
          displayName: "Authorized Labs",
          role: "owner",
          status: "active",
          active: true,
        },
        {
          accountId: "00000000-0000-4000-8000-000000000107",
          displayName: "Team Administration",
          role: "admin",
          status: "active",
          active: false,
        },
        {
          accountId: secondAccountId,
          displayName: "Assessment Operations",
          role: "operator",
          status: "active",
          active: false,
        },
        {
          accountId: "00000000-0000-4000-8000-000000000108",
          displayName: "Read-only Delivery",
          role: "viewer",
          status: "active",
          active: false,
        },
        {
          accountId: "00000000-0000-4000-8000-000000000109",
          displayName: "Plan & Billing",
          role: "billing",
          status: "active",
          active: false,
        },
      ],
    });

    const ownerTeam = await app.request(
      `http://localhost/api/v1/accounts/${accountId}/memberships`,
      { headers: { Cookie: cookie, Origin: origin } },
    );
    expect(ownerTeam.status).toBe(200);
    expect((await ownerTeam.json()).memberships).toHaveLength(5);

    const switched = await app.request("http://localhost/api/v1/account/switch", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountId: secondAccountId }),
    });
    expect(switched.status).toBe(200);
    const replacementCookie = switched.headers.get("set-cookie")?.split(";", 1)[0];
    if (!replacementCookie) throw new Error("replacement session cookie missing");
    const memberships = await app.request(
      `http://localhost/api/v1/accounts/${secondAccountId}/memberships`,
      { headers: { Cookie: replacementCookie, Origin: origin } },
    );
    expect(memberships.status).toBe(200);
    expect((await memberships.json()).memberships[0]).toMatchObject({
      accountId: secondAccountId,
      role: "operator",
      status: "active",
    });
  });

  it("exposes every local persona while keeping role capabilities server enforced", async () => {
    const app = createLocalDevelopmentApp(
      createConfig({ corsOrigin: origin, environment: "development", port: 3000 }),
    );
    const sessionResponse = await app.request("http://localhost/api/v1/auth/local-session");
    const initialCookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
    if (!initialCookie) throw new Error("local session cookie missing");

    const viewerAccountId = "00000000-0000-4000-8000-000000000108";
    const switched = await app.request("http://localhost/api/v1/account/switch", {
      method: "POST",
      headers: { Cookie: initialCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: viewerAccountId }),
    });
    const viewerCookie = switched.headers.get("set-cookie")?.split(";", 1)[0];
    if (!viewerCookie) throw new Error("viewer session cookie missing");

    const denied = await app.request(
      `http://localhost/api/v1/accounts/${viewerAccountId}/assessments`,
      {
        method: "POST",
        headers: { Cookie: viewerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          targetCategory: "surface",
          target: "example.test",
          scope: [],
          authorization: { accepted: true, termsVersion: "terms@1" },
        }),
      },
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("membership_required");
  });

  it("runs the local assessment journey from draft to queued", async () => {
    const app = createLocalDevelopmentApp(
      createConfig({ corsOrigin: origin, environment: "development", port: 3000 }),
    );
    const sessionResponse = await app.request("http://localhost/api/v1/auth/local-session");
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("local session cookie missing");

    const created = await app.request(`http://localhost/api/v1/accounts/${accountId}/assessments`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        targetCategory: "surface",
        target: "example.test",
        scope: [],
        authorization: { accepted: true, termsVersion: "terms@1" },
      }),
    });
    expect(created.status).toBe(201);
    const draft = (await created.json()).assessment;
    expect(draft).toMatchObject({
      accountId,
      target: "example.test",
      status: "draft",
      jobId: null,
    });

    const queued = await app.request(
      `http://localhost/api/v1/accounts/${accountId}/assessments/${draft.id}/queue`,
      { method: "POST", headers: { Cookie: cookie } },
    );
    expect(queued.status).toBe(200);
    expect((await queued.json()).assessment).toMatchObject({ status: "queued" });
  });
});
