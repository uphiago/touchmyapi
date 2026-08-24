import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRawDbConnection,
  type RawDbConnection,
} from "../../../packages/db/src/connection-internal";
import { createApiRuntime, type ApiRuntime } from "../src/runtime";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

function ownerUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for runtime integration tests");
  const parsed = new URL(value);
  if (parsed.hostname !== "127.0.0.1" || !parsed.pathname.endsWith("_test")) {
    throw new Error("Runtime tests require a loopback *_test database");
  }
  return value;
}

function connectorUrl(base: string, username: string, password: string): string {
  const parsed = new URL(base);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}

describeDb("production API runtime composition", () => {
  let owner!: RawDbConnection;
  let runtime!: ApiRuntime;

  beforeAll(async () => {
    const databaseUrl = ownerUrl();
    owner = createRawDbConnection(databaseUrl);
    await owner.unsafe(`alter role auth_connector password 'auth_connector_test'`);
    await owner.unsafe(`alter role api_connector password 'api_connector_test'`);
    await owner.unsafe(`alter role audit_system_connector password 'audit_connector_test'`);
    runtime = await createApiRuntime({
      NODE_ENV: "production",
      PORT: "3000",
      CORS_ORIGIN: "https://app.example.test",
      WEB_APP_ORIGIN: "https://app.example.test",
      AUTH_PROVIDER: "github",
      GITHUB_OAUTH_CLIENT_ID: "github-client",
      GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
      GITHUB_OAUTH_CALLBACK_URL: "https://api.example.test/api/v1/auth/github/callback",
      AUTH_TRANSIENT_KEY: Buffer.alloc(32, 7).toString("base64url"),
      AUTH_DATABASE_URL: connectorUrl(databaseUrl, "auth_connector", "auth_connector_test"),
      API_DATABASE_URL: connectorUrl(databaseUrl, "api_connector", "api_connector_test"),
      AUDIT_DATABASE_URL: connectorUrl(
        databaseUrl,
        "audit_system_connector",
        "audit_connector_test",
      ),
    });
  });

  afterAll(async () => {
    await runtime?.close();
    if (owner) {
      await owner`delete from public.audit_event where account_id is null and actor = 'customer_api'`;
      await owner.end();
    }
  });

  it("mounts GitHub, persistent auth, and a durable request audit sink", async () => {
    const providers = await runtime.app.request("https://api.example.test/api/v1/auth/providers", {
      headers: { Origin: "https://app.example.test" },
    });
    expect(providers.status).toBe(200);
    expect(await providers.json()).toEqual({ providers: [{ id: "github", label: "GitHub" }] });

    const session = await runtime.app.request("https://api.example.test/api/v1/auth/session", {
      headers: { Origin: "https://app.example.test" },
    });
    expect(session.status).toBe(401);
    const [audit] = await owner`
      select actor, action, payload_json from public.audit_event
      where account_id is null and actor = 'customer_api'
      order by chain_seq desc limit 1
    `;
    expect(audit).toMatchObject({ actor: "customer_api", action: "request" });
  });
});
