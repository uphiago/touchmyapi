import { describe, expect, it } from "vitest";

const enabled = process.env.RUN_LOCAL_E2E === "1";
const localDescribe = enabled ? describe : describe.skip;
const apiBaseUrl = process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const webBaseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:5173";

localDescribe("local customer journey", () => {
  it("walks landing → owner session → draft → queue → completed delivery", async () => {
    const web = await fetch(webBaseUrl);
    expect(web.ok).toBe(true);
    expect(await web.text()).toContain("TouchMyAPI");

    const health = await fetch(`${apiBaseUrl}/health`);
    expect(await health.json()).toEqual({ status: "ok" });

    const session = await fetch(`${apiBaseUrl}/api/v1/auth/local-session`, {
      headers: { Origin: webBaseUrl },
    });
    let cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    expect(session.ok).toBe(true);
    expect(cookie).toMatch(/^tma-session=/u);

    const accountsResponse = await fetch(`${apiBaseUrl}/api/v1/accounts`, {
      headers: { Cookie: cookie!, Origin: webBaseUrl },
    });
    const accounts = (await accountsResponse.json()) as {
      accounts?: readonly { accountId: string; active: boolean; role: string }[];
    };
    const owner = accounts.accounts?.find((account) => account.role === "owner");
    expect(owner).toBeDefined();
    if (!owner) return;
    if (!owner.active) {
      const switched = await fetch(`${apiBaseUrl}/api/v1/account/switch`, {
        method: "POST",
        headers: { Cookie: cookie!, Origin: webBaseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: owner.accountId }),
      });
      cookie = switched.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie;
      expect(switched.ok).toBe(true);
    }

    const created = await fetch(`${apiBaseUrl}/api/v1/accounts/${owner.accountId}/assessments`, {
      method: "POST",
      headers: { Cookie: cookie!, Origin: webBaseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({
        targetCategory: "surface",
        target: `e2e-${Date.now()}.example.com`,
        scope: [],
        authorization: { accepted: true, termsVersion: "terms@1" },
      }),
    });
    const draft = (await created.json()) as { assessment?: { id: string; status: string } };
    expect(created.status).toBe(201);
    expect(draft.assessment?.status).toBe("draft");
    if (!draft.assessment) return;

    const queued = await fetch(
      `${apiBaseUrl}/api/v1/accounts/${owner.accountId}/assessments/${draft.assessment.id}/queue`,
      { method: "POST", headers: { Cookie: cookie!, Origin: webBaseUrl } },
    );
    expect(queued.ok).toBe(true);
    expect((await queued.json()).assessment.status).toBe("queued");

    const deadline = Date.now() + 10_000;
    let state = "queued";
    while (Date.now() < deadline) {
      const list = await fetch(`${apiBaseUrl}/api/v1/accounts/${owner.accountId}/assessments`, {
        headers: { Cookie: cookie!, Origin: webBaseUrl },
      });
      const body = (await list.json()) as {
        assessments?: readonly { id: string; status: string }[];
      };
      state = body.assessments?.find((item) => item.id === draft.assessment?.id)?.status ?? state;
      if (state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(state).toBe("completed");

    const delivery = await fetch(
      `${apiBaseUrl}/api/v1/accounts/${owner.accountId}/assessments/${draft.assessment.id}/delivery`,
      { headers: { Cookie: cookie!, Origin: webBaseUrl } },
    );
    const deliveryBody = (await delivery.json()) as { status?: string; visibility?: string };
    expect(delivery.ok).toBe(true);
    expect(deliveryBody).toMatchObject({ status: "completed", visibility: "detailed" });

    const reports = await fetch(
      `${apiBaseUrl}/api/v1/accounts/${owner.accountId}/assessments/${draft.assessment.id}/reports`,
      { headers: { Cookie: cookie!, Origin: webBaseUrl } },
    );
    expect(reports.ok).toBe(true);
    expect((await reports.json()).reports).toHaveLength(3);
  }, 20_000);
});
