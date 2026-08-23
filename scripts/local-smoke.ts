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
      target: `smoke-${Date.now()}.example.test`,
      scope: [],
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
  console.log(`[smoke] PASS assessment draft → queued ${account.accountId}`);
}

const apiBaseUrl = process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";
const webBaseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:5173";
const timeoutMs = Number(process.env.LOCAL_SMOKE_TIMEOUT_MS ?? 30_000);
const checks: readonly Check[] = [
  {
    name: "API health",
    url: `${apiBaseUrl}/health`,
    validate: (response, body) => response.ok && body === JSON.stringify({ status: "ok" }),
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
