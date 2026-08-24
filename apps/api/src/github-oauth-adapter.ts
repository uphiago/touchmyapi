import type { GitHubOAuthAdapter, GitHubCodeExchange, OAuthIdentity } from "./auth";

const AUTHORIZATION_ENDPOINT = "https://github.com/login/oauth/authorize";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT = "https://api.github.com/user";
const EMAILS_ENDPOINT = "https://api.github.com/user/emails";
const API_VERSION = "2022-11-28";
const MAX_RESPONSE_BYTES = 64 * 1024;

export type GitHubOAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type GitHubOAuthAdapterOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: GitHubOAuthFetch;
  timeoutMs?: number;
}>;

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("provider response rejected");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("provider response too large");
  }
  return JSON.parse(text) as unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid provider response");
  }
  return value as Record<string, unknown>;
}

export function createGitHubOAuthAdapter(options: GitHubOAuthAdapterOptions): GitHubOAuthAdapter {
  if (!options.clientId.trim() || !options.clientSecret || !options.redirectUri) {
    throw new Error("invalid GitHub OAuth adapter");
  }
  const redirect = new URL(options.redirectUri);
  if (redirect.protocol !== "https:" && redirect.hostname !== "127.0.0.1") {
    throw new Error("invalid GitHub OAuth adapter");
  }
  const fetchImpl: GitHubOAuthFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("invalid GitHub OAuth adapter");
  }

  const exchangeCode = async (input: GitHubCodeExchange): Promise<OAuthIdentity> => {
    try {
      if (
        input.redirectUri !== redirect.toString() ||
        input.code.length === 0 ||
        input.code.length > 2048 ||
        !/^[A-Za-z0-9_-]{43,128}$/u.test(input.verifier)
      ) {
        throw new Error("invalid exchange input");
      }
      const tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "TouchMyAPI",
        },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.verifier,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const tokenPayload = objectValue(await readJson(tokenResponse));
      const accessToken = tokenPayload.access_token;
      if (typeof accessToken !== "string" || accessToken.length < 8 || accessToken.length > 2048) {
        throw new Error("invalid token response");
      }
      const githubHeaders = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "TouchMyAPI",
        "X-GitHub-Api-Version": API_VERSION,
      };
      const [userPayload, emailPayload] = await Promise.all([
        fetchImpl(USER_ENDPOINT, {
          headers: githubHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        }).then(readJson),
        fetchImpl(EMAILS_ENDPOINT, {
          headers: githubHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        }).then(readJson),
      ]);
      const user = objectValue(userPayload);
      if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0) {
        throw new Error("invalid user response");
      }
      if (!Array.isArray(emailPayload)) throw new Error("invalid email response");
      const primary = emailPayload
        .map(objectValue)
        .find(
          (entry) =>
            entry.primary === true &&
            entry.verified === true &&
            typeof entry.email === "string" &&
            entry.email.length <= 320,
        );
      if (!primary || typeof primary.email !== "string") {
        throw new Error("verified email unavailable");
      }
      return Object.freeze({
        provider: "github",
        subject: String(user.id),
        email: primary.email,
      });
    } catch {
      throw new Error("GitHub OAuth exchange failed");
    }
  };

  return Object.freeze({
    provider: "github",
    clientId: options.clientId,
    redirectUri: redirect.toString(),
    authorizationEndpoint: AUTHORIZATION_ENDPOINT,
    exchangeCode,
  });
}
