import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";

const processes: ChildProcess[] = [];

afterEach(() => {
  for (const process of processes.splice(0)) process.kill();
});

async function startProductionAdmin(port: number, origin: string) {
  const server = spawn("bun", ["apps/api/src/admin-server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      ADMIN_PORT: String(port),
      ADMIN_CORS_ORIGIN: origin,
      LOCAL_ADMIN_MOCKS: "0",
    },
    stdio: "ignore",
  });
  processes.push(server);

  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/health`);
      if (response.ok) return endpoint;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("production admin server did not become ready");
}

describe("production admin boundary", () => {
  it("returns its fail-closed response through exact-origin CORS", async () => {
    const origin = "https://admin.example.test";
    const endpoint = await startProductionAdmin(33191, origin);
    const response = await fetch(`${endpoint}/api/v1/admin/session`, {
      headers: { Origin: origin },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(await response.json()).toEqual({
      error: { code: "admin_unavailable", message: "Admin backend unavailable" },
    });
  });
});
