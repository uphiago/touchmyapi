import { afterEach, describe, expect, it } from "vitest";
import { createApp, type ApiDependencies } from "../src/app";
import { createConfig } from "../src/config";
import type { AuthSession, GoogleIdentityClaims, GoogleOidcAdapter, AuthStore } from "../src/auth";

const config = createConfig({
  corsOrigin: "https://console.example.test",
  environment: "test",
  port: 3100,
});
const key = new Uint8Array(32).fill(7);
const sessionCookieName = "__Secure-tma-session";
const oauthCookie = "__Secure-tma-oauth";

const claims: GoogleIdentityClaims = {
  issuer: "https://accounts.google.com",
  audience: "google-client-id",
  subject: "google-subject-1",
  email: "user@example.test",
  emailVerified: true,
  nonce: "provider-nonce",
};

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get("set-cookie");
  const match = header?.match(new RegExp(`${name}=([^;]+)`));
  if (!match?.[1]) throw new Error(`missing ${name} cookie`);
  return match[1];
}

function cookieHeader(response: Response): string {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

function createAuthFixture(
  overrides: Partial<{
    claims: GoogleIdentityClaims;
    exchangeError: Error;
  }> = {},
) {
  const exchanged: Array<{ code: string; verifier: string; nonce: string; redirectUri: string }> =
    [];
  const completed: Array<Parameters<AuthStore["completeGoogleLogin"]>[0]> = [];
  const resolved: string[] = [];
  const rotated: string[] = [];
  const revoked: string[] = [];
  const acceptedInvitations: Array<Parameters<NonNullable<AuthStore["acceptInvitation"]>>[0]> = [];
  const sessions = new Map<string, AuthSession>();
  const adapter: GoogleOidcAdapter = {
    clientId: "google-client-id",
    redirectUri: "https://api.example.test/api/v1/auth/callback",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    exchangeCode: async (input) => {
      exchanged.push(input);
      if (overrides.exchangeError) throw overrides.exchangeError;
      const exchangedClaims = overrides.claims ?? claims;
      return overrides.claims ? exchangedClaims : { ...exchangedClaims, nonce: input.nonce };
    },
  };
  const store: AuthStore = {
    completeGoogleLogin: async (input) => {
      completed.push(input);
      const session: AuthSession = {
        userId: "user-1",
        accountId: "account-1",
        email: input.email,
        role: "owner",
        membershipStatus: "active",
        plan: "free_unverified",
        iaEnabled: true,
      };
      sessions.set(input.sessionHash, session);
      return session;
    },
    resolveSession: async (hash) => {
      resolved.push(hash);
      return sessions.get(hash);
    },
    rotateSession: async ({ currentSessionHash, replacementSessionHash }) => {
      const session = sessions.get(currentSessionHash);
      if (!session) return undefined;
      rotated.push(currentSessionHash);
      sessions.delete(currentSessionHash);
      sessions.set(replacementSessionHash, session);
      return session;
    },
    revokeSession: async (hash) => {
      revoked.push(hash);
      sessions.delete(hash);
    },
    acceptInvitation: async (input) => {
      acceptedInvitations.push(input);
      const session: AuthSession = {
        userId: "user-1",
        accountId: "account-2",
        email: "user@example.test",
        role: "viewer",
        membershipStatus: "active",
        plan: "free_unverified",
        iaEnabled: true,
      };
      sessions.set(input.replacementSessionHash, session);
      return { session, rotated: true };
    },
    listAccounts: async () => [
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        role: "owner",
        status: "active",
        active: true,
      },
    ],
    switchAccount: async () => ({
      userId: "user-1",
      accountId: "account-2",
      email: "user@example.test",
      role: "viewer",
      membershipStatus: "active",
      plan: "free_unverified",
      iaEnabled: true,
    }),
  };
  const dependencies: ApiDependencies = {
    config,
    logger: { error: () => undefined },
    auditSink: { record: async () => undefined },
    auth: {
      adapter,
      store,
      transientKey: key,
      sessionMaxAgeSeconds: 3600,
      transientMaxAgeSeconds: 600,
      successRedirect: "https://console.example.test/",
    },
  };
  return {
    app: createApp(dependencies),
    exchanged,
    completed,
    resolved,
    rotated,
    revoked,
    acceptedInvitations,
    adapter,
    store,
  };
}

afterEach(() => {
  key.fill(7);
});

describe("Google OAuth boundary", () => {
  it("starts Google PKCE login with an encrypted transient cookie", async () => {
    const fixture = createAuthFixture();
    const response = await fixture.app.request("http://localhost/api/v1/auth/login");

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("google-client-id");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("state")).toHaveLength(43);
    expect(location.searchParams.get("nonce")).toHaveLength(43);
    expect(location.searchParams.get("code_challenge")).toHaveLength(43);

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${oauthCookie}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/api/v1/auth");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).not.toContain(location.searchParams.get("state") ?? "");
    expect(setCookie).not.toContain(location.searchParams.get("nonce") ?? "");
  });

  it("exchanges callback code, validates claims, and persists only a session hash", async () => {
    const fixture = createAuthFixture();
    const login = await fixture.app.request("http://localhost/api/v1/auth/login");
    const location = new URL(login.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    const callback = await fixture.app.request(
      `http://localhost/api/v1/auth/callback?code=provider-code&state=${state}`,
      { headers: { Cookie: cookieHeader(login) } },
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://console.example.test/");
    expect(fixture.exchanged[0]?.code).toBe("provider-code");
    expect(fixture.exchanged[0]?.redirectUri).toBe(fixture.adapter.redirectUri);
    expect(fixture.completed).toHaveLength(1);
    expect(fixture.completed[0]?.providerSubject).toBe("google-subject-1");
    expect(fixture.completed[0]?.email).toBe("user@example.test");
    expect(fixture.completed[0]?.sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.completed[0]?.sessionHash).not.toContain("provider-code");
    expect(fixture.completed[0]?.sessionHash).not.toContain("google-subject-1");
    const setCookie = responseCookie(callback, sessionCookieName);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/api/v1/auth");
    expect(setCookie).toContain("Max-Age=3600");
    expect(callback.headers.get("set-cookie")).toContain(`${oauthCookie}=;`);
  });

  it("rejects unsupported providers without contacting an adapter", async () => {
    const fixture = createAuthFixture();
    const response = await fixture.app.request(
      "http://localhost/api/v1/auth/login?provider=github",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "unsupported_provider", message: "Unsupported provider" },
    });
    expect(fixture.exchanged).toHaveLength(0);
  });

  it("rejects callback state mismatch and invalid claims without leaking details", async () => {
    const fixture = createAuthFixture({
      claims: { ...claims, issuer: "https://evil.example.test" },
    });
    const login = await fixture.app.request("http://localhost/api/v1/auth/login");
    const location = new URL(login.headers.get("location") ?? "");
    const wrongState = "a".repeat(43);
    const mismatch = await fixture.app.request(
      `http://localhost/api/v1/auth/callback?code=provider-code&state=${wrongState}`,
      { headers: { Cookie: cookieHeader(login) } },
    );
    expect(mismatch.status).toBe(401);
    expect(await mismatch.json()).toEqual({
      error: { code: "invalid_oauth_callback", message: "Authentication failed" },
    });

    const invalidClaims = await fixture.app.request(
      `http://localhost/api/v1/auth/callback?code=provider-code&state=${location.searchParams.get("state")}`,
      { headers: { Cookie: cookieHeader(login) } },
    );
    expect(invalidClaims.status).toBe(401);
    expect(await invalidClaims.json()).toEqual({
      error: { code: "invalid_oauth_callback", message: "Authentication failed" },
    });
    expect(fixture.completed).toHaveLength(0);
  });

  it("rejects a provider nonce mismatch and oversized callback input", async () => {
    const fixture = createAuthFixture({ claims: { ...claims, nonce: "wrong-nonce" } });
    const login = await fixture.app.request("http://localhost/api/v1/auth/login");
    const location = new URL(login.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    const nonceMismatch = await fixture.app.request(
      `/api/v1/auth/callback?code=provider-code&state=${state}`,
      { headers: { Cookie: cookieHeader(login) } },
    );
    expect(nonceMismatch.status).toBe(401);
    expect(await nonceMismatch.json()).toEqual({
      error: { code: "invalid_oauth_callback", message: "Authentication failed" },
    });

    const oversized = await fixture.app.request(
      `/api/v1/auth/callback?code=${"x".repeat(2049)}&state=${state}`,
      { headers: { Cookie: cookieHeader(login) } },
    );
    expect(oversized.status).toBe(401);
    expect(await oversized.json()).toEqual({
      error: { code: "invalid_oauth_callback", message: "Authentication failed" },
    });
  });

  it("rejects an otherwise-valid provider response with no nonce", async () => {
    const fixture = createAuthFixture({
      claims: { ...claims, nonce: undefined } as unknown as GoogleIdentityClaims,
    });
    const login = await fixture.app.request("http://localhost/api/v1/auth/login");
    const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
    const response = await fixture.app.request(
      `http://localhost/api/v1/auth/callback?code=provider-code&state=${state}`,
      { headers: { Cookie: cookieHeader(login) } },
    );
    expect(response.status).toBe(401);
    expect(fixture.completed).toHaveLength(0);
  });

  it("resolves /me from a hash-only session and revokes it on logout", async () => {
    const fixture = createAuthFixture();
    const login = await fixture.app.request("http://localhost/api/v1/auth/login");
    const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
    const callback = await fixture.app.request(
      `http://localhost/api/v1/auth/callback?code=provider-code&state=${state}`,
      { headers: { Cookie: cookieHeader(login) } },
    );
    const sessionCookie = cookieValue(callback, sessionCookieName);
    const me = await fixture.app.request("http://localhost/api/v1/auth/me", {
      headers: { Cookie: `${sessionCookieName}=${sessionCookie}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: { id: "user-1", email: "user@example.test" },
      account: { id: "account-1", role: "owner", plan: "free_unverified", iaEnabled: true },
    });
    expect(fixture.resolved[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.resolved[0]).not.toBe(sessionCookie);
    const replacementCookie = cookieValue(me, sessionCookieName);
    expect(replacementCookie).not.toBe(sessionCookie);
    expect(fixture.rotated).toHaveLength(1);

    const session = await fixture.app.request("http://localhost/api/v1/auth/session", {
      headers: { Cookie: `${sessionCookieName}=${replacementCookie}` },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({
      user: { id: "user-1", email: "user@example.test" },
      account: { id: "account-1", role: "owner", plan: "free_unverified", iaEnabled: true },
    });
    const finalCookie = cookieValue(session, sessionCookieName);

    const logout = await fixture.app.request("http://localhost/api/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: `${sessionCookieName}=${finalCookie}` },
    });
    expect(logout.status).toBe(204);
    expect(fixture.revoked[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(logout.headers.get("set-cookie")).toContain(`${sessionCookieName}=;`);
  });

  it("does not hash or resolve malformed session cookie values", async () => {
    const fixture = createAuthFixture();
    const malformed = await fixture.app.request("http://localhost/api/v1/auth/me", {
      headers: { Cookie: `${sessionCookieName}=${"x".repeat(4097)}` },
    });
    expect(malformed.status).toBe(401);
    expect(fixture.resolved).toHaveLength(0);

    const logout = await fixture.app.request("http://localhost/api/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: `${sessionCookieName}=${"x".repeat(4097)}` },
    });
    expect(logout.status).toBe(204);
    expect(fixture.revoked).toHaveLength(0);
  });

  it("accepts an invitation only from the explicit body and rotates the session cookie", async () => {
    const fixture = createAuthFixture();
    const sessionToken = "A".repeat(43);
    const rawInvitationToken = "B".repeat(43);
    const response = await fixture.app.request("http://localhost/api/v1/invitations/accept", {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName}=${sessionToken}`,
        Origin: "https://console.example.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: rawInvitationToken }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      account: { id: "account-2", role: "viewer" },
      user: { id: "user-1" },
    });
    expect(fixture.acceptedInvitations).toHaveLength(1);
    expect(fixture.acceptedInvitations[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.acceptedInvitations[0]?.tokenHash).not.toContain(rawInvitationToken);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://console.example.test",
    );
    expect(response.headers.get("set-cookie")).toContain(`${sessionCookieName}=`);
  });

  it("lists safe account summaries and switches only through the session store", async () => {
    const fixture = createAuthFixture();
    const response = await fixture.app.request("http://localhost/api/v1/accounts", {
      headers: {
        Cookie: `${sessionCookieName}=${"A".repeat(43)}`,
        Origin: "https://console.example.test",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accounts: [
        {
          accountId: "11111111-1111-4111-8111-111111111111",
          role: "owner",
          status: "active",
          active: true,
        },
      ],
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://console.example.test",
    );

    const switched = await fixture.app.request("http://localhost/api/v1/account/switch", {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName}=${"A".repeat(43)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountId: "22222222-2222-4222-8222-222222222222" }),
    });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({
      account: { id: "account-2", role: "viewer" },
      user: { id: "user-1" },
    });
  });
});

describe("GitHub OAuth boundary", () => {
  it("discovers GitHub and completes Authorization Code with PKCE", async () => {
    const base = createAuthFixture();
    const completed: unknown[] = [];
    const store = {
      ...base.store,
      completeProviderLogin: async (input: unknown) => {
        completed.push(input);
        return {
          userId: "user-1",
          accountId: "account-1",
          email: "owner@example.test",
          role: "owner",
          membershipStatus: "active",
          plan: "free_unverified",
          iaEnabled: true,
        };
      },
    };
    const dependencies = {
      config,
      logger: { error: () => undefined },
      auditSink: { record: async () => undefined },
      auth: {
        githubAdapter: {
          provider: "github",
          clientId: "github-client-id",
          redirectUri: "https://api.example.test/api/v1/auth/github/callback",
          authorizationEndpoint: "https://github.com/login/oauth/authorize",
          exchangeCode: async () => ({
            provider: "github",
            subject: "12345",
            email: "owner@example.test",
          }),
        },
        store,
        transientKey: key,
        sessionMaxAgeSeconds: 3600,
        transientMaxAgeSeconds: 600,
        successRedirect: "https://console.example.test/",
      },
    } as unknown as ApiDependencies;
    const app = createApp(dependencies);

    const providers = await app.request("http://localhost/api/v1/auth/providers");
    expect(providers.status).toBe(200);
    expect(await providers.json()).toEqual({ providers: [{ id: "github", label: "GitHub" }] });

    const start = await app.request("http://localhost/api/v1/auth/github/start");
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("client_id")).toBe("github-client-id");
    expect(location.searchParams.get("scope")).toBe("user:email");
    expect(location.searchParams.get("state")).toHaveLength(43);
    expect(location.searchParams.get("code_challenge")).toHaveLength(43);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const callback = await app.request(
      `http://localhost/api/v1/auth/github/callback?code=provider-code&state=${location.searchParams.get("state")}`,
      { headers: { Cookie: cookieHeader(start) } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://console.example.test/");
    expect(completed).toEqual([
      expect.objectContaining({
        provider: "github",
        providerSubject: "12345",
        email: "owner@example.test",
        sessionHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    ]);
    expect(callback.headers.get("set-cookie")).toContain(`${sessionCookieName}=`);
    expect(callback.headers.get("set-cookie")).not.toContain("provider-code");
  });
});

function responseCookie(response: Response, name: string): string {
  return (
    response.headers
      .get("set-cookie")
      ?.split("\n")
      .find((value) => value.startsWith(`${name}=`)) ?? ""
  );
}
