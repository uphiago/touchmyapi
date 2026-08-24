import { describe, expect, it } from "vitest";
import { createGitHubOAuthAdapter, type GitHubOAuthFetch } from "../src/github-oauth-adapter";

type RecordedRequest = Readonly<{ url: string; init?: RequestInit }>;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub OAuth adapter", () => {
  it("exchanges PKCE code and selects the primary verified email", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl: GitHubOAuthFetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "https://github.com/login/oauth/access_token") {
        return jsonResponse({
          access_token: "provider-token",
          token_type: "bearer",
          scope: "user:email",
        });
      }
      if (url === "https://api.github.com/user") {
        return jsonResponse({ id: 12345, login: "touch-owner" });
      }
      return jsonResponse([
        { email: "secondary@example.test", primary: false, verified: true },
        { email: "owner@example.test", primary: true, verified: true },
      ]);
    };
    const adapter = createGitHubOAuthAdapter({
      clientId: "github-client",
      clientSecret: "github-secret",
      redirectUri: "https://api.example.test/api/v1/auth/github/callback",
      fetchImpl,
    });

    const identity = await adapter.exchangeCode({
      code: "provider-code",
      verifier: "v".repeat(43),
      redirectUri: adapter.redirectUri,
    });

    expect(identity).toEqual({
      provider: "github",
      subject: "12345",
      email: "owner@example.test",
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/user/emails",
    ]);
    const tokenBody = String(requests[0]?.init?.body);
    expect(tokenBody).toContain("code_verifier=");
    expect(tokenBody).toContain("client_secret=github-secret");
    expect(requests[1]?.init?.headers).toMatchObject({ Authorization: "Bearer provider-token" });
  });

  it("fails closed for token errors, unsafe identities, and absent verified email", async () => {
    const tokenFailure = createGitHubOAuthAdapter({
      clientId: "github-client",
      clientSecret: "github-secret",
      redirectUri: "https://api.example.test/api/v1/auth/github/callback",
      fetchImpl: async () => jsonResponse({ error: "bad_verification_code" }, 400),
    });
    await expect(
      tokenFailure.exchangeCode({
        code: "provider-code",
        verifier: "v".repeat(43),
        redirectUri: tokenFailure.redirectUri,
      }),
    ).rejects.toThrow("GitHub OAuth exchange failed");

    let call = 0;
    const noEmail = createGitHubOAuthAdapter({
      clientId: "github-client",
      clientSecret: "github-secret",
      redirectUri: "https://api.example.test/api/v1/auth/github/callback",
      fetchImpl: async () => {
        call += 1;
        if (call === 1) return jsonResponse({ access_token: "provider-token" });
        if (call === 2) return jsonResponse({ id: 12345, login: "touch-owner" });
        return jsonResponse([{ email: "owner@example.test", primary: true, verified: false }]);
      },
    });
    await expect(
      noEmail.exchangeCode({
        code: "provider-code",
        verifier: "v".repeat(43),
        redirectUri: noEmail.redirectUri,
      }),
    ).rejects.toThrow("GitHub OAuth exchange failed");
  });
});
