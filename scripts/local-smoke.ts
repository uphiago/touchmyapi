export {};

type Check = Readonly<{
  name: string;
  url: string;
  validate: (response: Response, body: string) => boolean;
}>;

async function checkLocalAssessmentJourney(): Promise<void> {
  const session = await fetch(`${apiBaseUrl}/api/v1/auth/local-session`, {
    headers: { Origin: webBaseUrl },
  });
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  if (
    !session.ok ||
    !cookie ||
    session.headers.get("access-control-allow-origin") !== webBaseUrl ||
    session.headers.get("access-control-allow-credentials") !== "true"
  ) {
    throw new Error("local browser session or CORS bootstrap failed");
  }
  const accountsResponse = await fetch(`${apiBaseUrl}/api/v1/accounts`, {
    headers: { Cookie: cookie, Origin: webBaseUrl },
  });
  const accounts = (await accountsResponse.json()) as {
    accounts?: readonly { accountId: string; active: boolean }[];
  };
  const account = accounts.accounts?.find((item) => item.active) ?? accounts.accounts?.[0];
  if (!accountsResponse.ok || !account) throw new Error("local account bootstrap failed");
  const created = await fetch(`${apiBaseUrl}/api/v1/accounts/${account.accountId}/assessments`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: webBaseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({
      targetCategory: "surface",
      // A syntactically public host exercises the real policy compiler. The
      // persistent local adapter resolves it to a fixed fixture address and
      // the fixture runner never performs target network access.
      target: `smoke-${Date.now()}.example.com`,
      scope: [],
      authorization: { accepted: true, termsVersion: "terms@1" },
    }),
  });
  const draft = (await created.json()) as { assessment?: { id: string; status: string } };
  if (!created.ok || draft.assessment?.status !== "draft") {
    throw new Error(`local assessment create failed: HTTP ${created.status}`);
  }
  const queued = await fetch(
    `${apiBaseUrl}/api/v1/accounts/${account.accountId}/assessments/${draft.assessment.id}/queue`,
    { method: "POST", headers: { Cookie: cookie, Origin: webBaseUrl } },
  );
  const result = (await queued.json()) as { assessment?: { status: string; jobId: string | null } };
  if (!queued.ok || result.assessment?.status !== "queued" || !result.assessment.jobId) {
    throw new Error(`local assessment queue failed: HTTP ${queued.status}`);
  }
  const deliveryDeadline = Date.now() + 10_000;
  let completed = false;
  while (Date.now() < deliveryDeadline) {
    const list = await fetch(`${apiBaseUrl}/api/v1/accounts/${account.accountId}/assessments`, {
      headers: { Cookie: cookie, Origin: webBaseUrl },
    });
    const body = (await list.json()) as {
      assessments?: readonly { id: string; status: string }[];
    };
    completed =
      list.ok &&
      body.assessments?.find((item) => item.id === draft.assessment?.id)?.status === "completed";
    if (completed) break;
    await Bun.sleep(100);
  }
  if (!completed || !draft.assessment) throw new Error("local worker delivery did not complete");

  const delivery = await fetch(
    `${apiBaseUrl}/api/v1/accounts/${account.accountId}/assessments/${draft.assessment.id}/delivery`,
    { headers: { Cookie: cookie, Origin: webBaseUrl } },
  );
  const delivered = (await delivery.json()) as {
    status?: string;
    visibility?: string;
    summary?: { total?: number };
  };
  if (
    !delivery.ok ||
    delivered.status !== "completed" ||
    delivered.visibility !== "detailed" ||
    !delivered.summary?.total
  ) {
    throw new Error("local plan-filtered delivery failed");
  }
  const notifications = await fetch(
    `${apiBaseUrl}/api/v1/accounts/${account.accountId}/notifications`,
    { headers: { Cookie: cookie, Origin: webBaseUrl } },
  );
  const notificationBody = (await notifications.json()) as { unreadCount?: number };
  if (!notifications.ok || !notificationBody.unreadCount) {
    throw new Error("local completion notification missing");
  }
  const reports = await fetch(
    `${apiBaseUrl}/api/v1/accounts/${account.accountId}/assessments/${draft.assessment.id}/reports`,
    { headers: { Cookie: cookie, Origin: webBaseUrl } },
  );
  const reportBody = (await reports.json()) as {
    reports?: readonly { id: string; kind: string }[];
  };
  if (
    !reports.ok ||
    reportBody.reports?.length !== 3 ||
    !["json", "pdf_technical", "pdf_executive"].every((kind) =>
      reportBody.reports?.some((report) => report.kind === kind),
    )
  ) {
    throw new Error("local private report publication failed");
  }
  for (const report of reportBody.reports) {
    const download = await fetch(
      `${apiBaseUrl}/api/v1/accounts/${account.accountId}/assessments/${draft.assessment.id}/reports/${report.id}/download`,
      { headers: { Cookie: cookie, Origin: webBaseUrl } },
    );
    const downloadBody = (await download.json()) as { url?: string; expiresAt?: string };
    if (
      !download.ok ||
      !downloadBody.url ||
      !downloadBody.expiresAt ||
      /touchmyapi_dev_change_me|secretaccesskey/iu.test(downloadBody.url)
    ) {
      throw new Error("local short-lived report URL failed");
    }
    const object = await fetch(downloadBody.url);
    const bytes = new Uint8Array(await object.arrayBuffer());
    const prefix = new TextDecoder().decode(bytes.subarray(0, 64));
    if (
      !object.ok ||
      (report.kind === "json" ? !prefix.includes("assessmentId") : !prefix.startsWith("%PDF-1."))
    ) {
      throw new Error(`local private ${report.kind} download failed`);
    }
  }
  console.log(
    `[smoke] PASS draft → queued → completed → detailed delivery → 3 private reports ${account.accountId}`,
  );

  const adminCrossBoundary = await fetch(`${adminApiBaseUrl}/api/v1/admin/snapshot`, {
    headers: { Cookie: cookie, Origin: adminWebBaseUrl },
  });
  if (adminCrossBoundary.status !== 401) {
    throw new Error("customer cookie accepted by admin");
  }
}

async function checkLocalAdminJourney(): Promise<void> {
  const session = await fetch(`${adminApiBaseUrl}/api/v1/admin/auth/local-session`, {
    method: "POST",
    headers: { Origin: adminWebBaseUrl },
  });
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  if (
    !session.ok ||
    !cookie?.startsWith("tma-admin-session=") ||
    session.headers.get("access-control-allow-origin") !== adminWebBaseUrl ||
    session.headers.get("access-control-allow-credentials") !== "true"
  ) {
    throw new Error("local admin session or CORS bootstrap failed");
  }

  const customerCrossBoundary = await fetch(`${apiBaseUrl}/api/v1/accounts`, {
    headers: { Cookie: cookie, Origin: webBaseUrl },
  });
  if (customerCrossBoundary.status !== 401) {
    throw new Error("admin cookie accepted by customer");
  }

  const snapshotResponse = await fetch(`${adminApiBaseUrl}/api/v1/admin/snapshot`, {
    headers: { Cookie: cookie, Origin: adminWebBaseUrl },
  });
  const snapshot = (await snapshotResponse.json()) as {
    accounts?: readonly { accountId: string }[];
    queue?: readonly { jobId: string }[];
  };
  const account = snapshot.accounts?.[0];
  const job = snapshot.queue?.[0];
  if (!snapshotResponse.ok || !account || !job) throw new Error("local admin snapshot failed");

  const grantResponse = await fetch(`${adminApiBaseUrl}/api/v1/admin/grants`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: adminWebBaseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: account.accountId,
      capability: "queue.requeue",
      ticket: "OPS-1234",
      reason: "Recover one reviewed local queue item",
      ttlSeconds: 900,
    }),
  });
  const grant = (await grantResponse.json()) as { grant?: { id: string } };
  if (!grantResponse.ok || !grant.grant) throw new Error("local admin grant request failed");

  const approval = await fetch(
    `${adminApiBaseUrl}/api/v1/admin/grants/${grant.grant.id}/approval`,
    {
      method: "POST",
      headers: { Cookie: cookie, Origin: adminWebBaseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ approverId: "local-approver", decision: "approved" }),
    },
  );
  if (!approval.ok) throw new Error("local admin distinct approval failed");

  const action = await fetch(`${adminApiBaseUrl}/api/v1/admin/queue/actions`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: adminWebBaseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({
      grantId: grant.grant.id,
      accountId: account.accountId,
      action: "queue.requeue",
      jobId: job.jobId,
    }),
  });
  const result = (await action.json()) as { result?: { status: string; simulated: boolean } };
  if (!action.ok || result.result?.status !== "accepted" || result.result.simulated !== true) {
    throw new Error("local admin bounded queue action failed");
  }
  console.log("[smoke] PASS admin grant → distinct approval → bounded simulation");
}

const apiBaseUrl = process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const webBaseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:5173";
const adminApiBaseUrl = process.env.ADMIN_API_BASE_URL ?? "http://127.0.0.1:3001";
const adminWebBaseUrl = process.env.ADMIN_WEB_BASE_URL ?? "http://127.0.0.1:5174";
const workerBaseUrl = process.env.WORKER_BASE_URL ?? "http://127.0.0.1:3002";
const timeoutMs = Number(process.env.LOCAL_SMOKE_TIMEOUT_MS ?? 30_000);
const checks: readonly Check[] = [
  {
    name: "worker readiness",
    url: `${workerBaseUrl}/ready`,
    validate: (response, body) =>
      response.ok && body === JSON.stringify({ status: "ready", runner: "fixture" }),
  },
  {
    name: "API health",
    url: `${apiBaseUrl}/health`,
    validate: (response, body) => response.ok && body === JSON.stringify({ status: "ok" }),
  },
  {
    name: "admin API health",
    url: `${adminApiBaseUrl}/health`,
    validate: (response, body) =>
      response.ok && body === JSON.stringify({ status: "ok", boundary: "admin" }),
  },
  {
    name: "admin web shell",
    url: adminWebBaseUrl,
    validate: (response, body) => response.ok && body.includes("TouchMyAPI"),
  },
  {
    name: "web shell",
    url: webBaseUrl,
    validate: (response, body) => response.ok && body.includes("TouchMyAPI"),
  },
];

const deadline = Date.now() + timeoutMs;
let lastError = "not started";

while (Date.now() < deadline) {
  let passed = true;
  for (const check of checks) {
    try {
      const response = await fetch(check.url);
      const body = await response.text();
      if (!check.validate(response, body)) {
        passed = false;
        lastError = `${check.name}: HTTP ${response.status}`;
        continue;
      }
      console.log(`[smoke] PASS ${check.name} ${check.url}`);
    } catch (error) {
      passed = false;
      lastError = `${check.name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (passed) {
    try {
      await checkLocalAssessmentJourney();
      await checkLocalAdminJourney();
      console.log("[smoke] local stack is responding");
      process.exit(0);
    } catch (error) {
      passed = false;
      lastError = `assessment journey: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  await Bun.sleep(500);
}

console.error(`[smoke] FAIL local stack did not become ready: ${lastError}`);
process.exit(1);
