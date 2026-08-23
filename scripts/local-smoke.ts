export {};

type Check = Readonly<{
  name: string;
  url: string;
  validate: (response: Response, body: string) => boolean;
}>;

const apiBaseUrl = process.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const webBaseUrl = process.env.WEB_BASE_URL ?? "http://localhost:5173";
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
    console.log("[smoke] local stack is responding");
    process.exit(0);
  }
  await Bun.sleep(500);
}

console.error(`[smoke] FAIL local stack did not become ready: ${lastError}`);
process.exit(1);
