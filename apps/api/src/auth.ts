import { ApiError } from "./error";
import {
  accountListResponseSchema,
  accountSwitchSchema,
  invitationAcceptSchema,
} from "@touchmyapi/contracts";
import type { Context, Hono } from "hono";
import type { ApiRequestEnv } from "./request-id";
import type { ApiEnvironment } from "./config";

const GOOGLE_ISSUER = "https://accounts.google.com";
const OAUTH_COOKIE = "__Secure-tma-oauth";
const SESSION_COOKIE = "__Secure-tma-session";
const COOKIE_PATH = "/api/v1/auth";
const SESSION_COOKIE_PATH = "/api/v1";
const MAX_COOKIE_BYTES = 4096;
const TOKEN_LENGTH = 43;
const TEXT = new TextEncoder();

export type GoogleIdentityClaims = {
  issuer: string;
  audience: string | readonly string[];
  subject: string;
  email: string;
  emailVerified: boolean;
  nonce: string;
};

export type GoogleCodeExchange = Readonly<{
  code: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
}>;

export type GoogleOidcAdapter = {
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  exchangeCode: (input: GoogleCodeExchange) => Promise<GoogleIdentityClaims>;
};

export type AuthSession = Readonly<{
  userId: string;
  accountId: string;
  email: string;
  role: string;
  plan: string;
  iaEnabled: boolean;
}>;

export type InvitationAcceptance = Readonly<{
  session: AuthSession;
  rotated: boolean;
}>;

export type AuthStore = Readonly<{
  completeGoogleLogin: (input: {
    providerSubject: string;
    email: string;
    sessionHash: string;
    expiresAt: Date;
    ip?: string;
    userAgent?: string;
  }) => Promise<AuthSession | undefined>;
  resolveSession: (sessionHash: string) => Promise<AuthSession | undefined>;
  rotateSession: (input: {
    currentSessionHash: string;
    replacementSessionHash: string;
    replacementExpiresAt: Date;
  }) => Promise<AuthSession | undefined>;
  revokeSession: (sessionHash: string) => Promise<void>;
  /** Optional until the database-backed membership slice is wired in production. */
  acceptInvitation?: (input: {
    sessionHash: string;
    tokenHash: string;
    replacementSessionHash: string;
    replacementExpiresAt: Date;
  }) => Promise<InvitationAcceptance | undefined>;
  listAccounts?: (sessionHash: string) => Promise<
    readonly {
      accountId: string;
      role: string;
      status: string;
      active: boolean;
    }[]
  >;
  switchAccount?: (input: {
    sessionHash: string;
    targetAccountId: string;
    replacementSessionHash: string;
    replacementExpiresAt: Date;
  }) => Promise<AuthSession | undefined>;
}>;

export type AuthDependencies = Readonly<{
  adapter: GoogleOidcAdapter;
  store: AuthStore;
  transientKey: Uint8Array;
  sessionMaxAgeSeconds: number;
  transientMaxAgeSeconds: number;
  successRedirect: string;
  allowInsecureCookies?: boolean;
}>;

type TransientState = Readonly<{
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}>;

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw new Error("invalid cookie");
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  try {
    return encode(bytes);
  } finally {
    bytes.fill(0);
  }
}

async function sha256(value: Uint8Array | string): Promise<Uint8Array> {
  const source = typeof value === "string" ? TEXT.encode(value) : value;
  const input = new Uint8Array(new ArrayBuffer(source.byteLength));
  input.set(source);
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  } finally {
    input.fill(0);
    if (typeof value === "string") source.fill(0);
  }
}

async function hashSession(token: string): Promise<string> {
  const digest = await sha256(token);
  try {
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    digest.fill(0);
  }
}

/** Public only for the typed API adapter; raw session tokens never cross this boundary. */
export const hashSessionToken = hashSession;
export const generateSessionToken = randomToken;

async function sealTransient(value: TransientState, key: Uint8Array): Promise<string> {
  if (key.byteLength !== 32) throw new Error("invalid transient key");
  const keyCopy = new Uint8Array(new ArrayBuffer(32));
  keyCopy.set(key);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const plaintext = TEXT.encode(JSON.stringify(value));
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", keyCopy, "AES-GCM", false, ["encrypt"]);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, tagLength: 128 },
        cryptoKey,
        plaintext,
      ),
    );
    try {
      return `${encode(nonce)}.${encode(ciphertext)}`;
    } finally {
      ciphertext.fill(0);
    }
  } finally {
    plaintext.fill(0);
    keyCopy.fill(0);
    nonce.fill(0);
  }
}

async function openTransient(value: string, key: Uint8Array): Promise<TransientState> {
  if (key.byteLength !== 32) throw new Error("invalid transient key");
  if (value.length > MAX_COOKIE_BYTES) throw new Error("invalid cookie");
  const parts = value.split(".");
  if (parts.length !== 2) throw new Error("invalid cookie");
  const [nonceValue, ciphertextValue] = parts;
  if (
    !nonceValue ||
    !ciphertextValue ||
    nonceValue.length !== 16 ||
    ciphertextValue.length > MAX_COOKIE_BYTES
  )
    throw new Error("invalid cookie");
  const nonce = decode(nonceValue);
  const ciphertext = decode(ciphertextValue);
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 16) throw new Error("invalid cookie");
  const ciphertextCopy = new Uint8Array(new ArrayBuffer(ciphertext.byteLength));
  ciphertextCopy.set(ciphertext);
  const nonceCopy = new Uint8Array(new ArrayBuffer(nonce.byteLength));
  nonceCopy.set(nonce);
  const keyCopy = new Uint8Array(new ArrayBuffer(32));
  keyCopy.set(key);
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", keyCopy, "AES-GCM", false, ["decrypt"]);
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonceCopy }, cryptoKey, ciphertextCopy),
    );
    try {
      const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      ) as TransientState;
      if (
        typeof parsed.state !== "string" ||
        typeof parsed.nonce !== "string" ||
        typeof parsed.verifier !== "string" ||
        typeof parsed.returnTo !== "string" ||
        typeof parsed.expiresAt !== "number" ||
        parsed.state.length !== TOKEN_LENGTH ||
        parsed.nonce.length !== TOKEN_LENGTH ||
        parsed.verifier.length !== TOKEN_LENGTH ||
        parsed.returnTo.length > 2048 ||
        parsed.expiresAt <= Date.now()
      )
        throw new Error("invalid cookie");
      return parsed;
    } finally {
      plaintext.fill(0);
    }
  } finally {
    keyCopy.fill(0);
    nonce.fill(0);
    nonceCopy.fill(0);
    ciphertext.fill(0);
    ciphertextCopy.fill(0);
  }
}

function cookieHeader(name: string, value: string, maxAge: number, secure: boolean): string {
  const path = name.includes("oauth") ? COOKIE_PATH : SESSION_COOKIE_PATH;
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearCookie(name: string, secure: boolean): string {
  return cookieHeader(name, "", 0, secure);
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || undefined;
  }
  return undefined;
}

function readSessionToken(request: Request, name: string): string | undefined {
  const token = readCookie(request, name);
  if (token === undefined) return undefined;
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : undefined;
}

function addCookie(response: Response, value: string): void {
  response.headers.append("set-cookie", value);
}

function validateClaims(claims: GoogleIdentityClaims, adapter: GoogleOidcAdapter): void {
  if (
    claims.issuer !== GOOGLE_ISSUER ||
    !(Array.isArray(claims.audience) ? claims.audience : [claims.audience]).includes(
      adapter.clientId,
    ) ||
    typeof claims.subject !== "string" ||
    claims.subject.length === 0 ||
    typeof claims.email !== "string" ||
    claims.email.length === 0 ||
    new TextEncoder().encode(claims.subject).byteLength > 256 ||
    new TextEncoder().encode(claims.email).byteLength > 320 ||
    claims.emailVerified !== true
  )
    throw new Error("invalid claims");
}

export function registerAuthRoutes(
  api: Hono<ApiRequestEnv>,
  auth: AuthDependencies,
  environment: ApiEnvironment = "production",
): void {
  const secure = !(auth.allowInsecureCookies === true && environment === "development");
  const oauthCookieName = secure ? OAUTH_COOKIE : "tma-oauth";
  const sessionCookieName = secure ? SESSION_COOKIE : "tma-session";
  api.get("/api/v1/auth/login", async (context) => {
    if ((context.req.query("provider") ?? "google") !== "google") {
      throw new ApiError(400, "unsupported_provider", "Unsupported provider");
    }
    try {
      if (auth.transientKey.byteLength !== 32) throw new Error("invalid transient key");
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken();
      const challengeBytes = await sha256(verifier);
      let challenge: string;
      try {
        challenge = encode(challengeBytes);
      } finally {
        challengeBytes.fill(0);
      }
      const expiresAt = Date.now() + auth.transientMaxAgeSeconds * 1000;
      const transient = await sealTransient(
        { state, nonce, verifier, returnTo: auth.successRedirect, expiresAt },
        auth.transientKey,
      );
      const location = new URL(auth.adapter.authorizationEndpoint);
      location.searchParams.set("client_id", auth.adapter.clientId);
      location.searchParams.set("redirect_uri", auth.adapter.redirectUri);
      location.searchParams.set("response_type", "code");
      location.searchParams.set("scope", "openid email profile");
      location.searchParams.set("state", state);
      location.searchParams.set("nonce", nonce);
      location.searchParams.set("code_challenge", challenge);
      location.searchParams.set("code_challenge_method", "S256");
      const response = new Response(null, {
        status: 302,
        headers: { location: location.toString() },
      });
      addCookie(
        response,
        cookieHeader(oauthCookieName, transient, auth.transientMaxAgeSeconds, secure),
      );
      return response;
    } catch {
      throw new ApiError(503, "auth_unavailable", "Authentication unavailable");
    }
  });

  api.get("/api/v1/auth/callback", async (context) => {
    const clear = () => context.header("set-cookie", clearCookie(oauthCookieName, secure));
    try {
      const code = context.req.query("code");
      const state = context.req.query("state");
      const cookie = readCookie(context.req.raw, oauthCookieName);
      if (!code || !state || !cookie) throw new Error("invalid callback");
      if (code.length > 2048 || state.length > 128) throw new Error("invalid callback");
      const transient = await openTransient(cookie, auth.transientKey);
      if (state !== transient.state) throw new Error("invalid callback");
      const claims = await auth.adapter.exchangeCode({
        code,
        verifier: transient.verifier,
        nonce: transient.nonce,
        redirectUri: auth.adapter.redirectUri,
      });
      validateClaims(claims, auth.adapter);
      if (claims.nonce !== transient.nonce) throw new Error("invalid claims");
      const sessionToken = randomToken();
      const sessionHash = await hashSession(sessionToken);
      const expiresAt = new Date(Date.now() + auth.sessionMaxAgeSeconds * 1000);
      const session = await auth.store.completeGoogleLogin({
        providerSubject: claims.subject,
        email: claims.email,
        sessionHash,
        expiresAt,
      });
      if (!session) throw new Error("login unavailable");
      const response = new Response(null, {
        status: 302,
        headers: { location: transient.returnTo },
      });
      addCookie(
        response,
        cookieHeader(sessionCookieName, sessionToken, auth.sessionMaxAgeSeconds, secure),
      );
      addCookie(response, clearCookie(oauthCookieName, secure));
      return response;
    } catch {
      clear();
      throw new ApiError(401, "invalid_oauth_callback", "Authentication failed");
    }
  });

  api.post("/api/v1/auth/logout", async (context) => {
    try {
      const token = readSessionToken(context.req.raw, sessionCookieName);
      if (token) await auth.store.revokeSession(await hashSession(token));
      const response = new Response(null, { status: 204 });
      addCookie(response, clearCookie(sessionCookieName, secure));
      return response;
    } catch {
      throw new ApiError(503, "auth_unavailable", "Authentication unavailable");
    }
  });

  api.post("/api/v1/invitations/accept", async (context) => {
    try {
      const token = readSessionToken(context.req.raw, sessionCookieName);
      if (!token || !auth.store.acceptInvitation) {
        throw new ApiError(400, "invalid_invitation", "Invalid invitation");
      }
      const body = invitationAcceptSchema.parse(await context.req.json());
      const sessionHash = await hashSession(token);
      const tokenHash = await hashInvitationBody(body.token);
      const replacementToken = randomToken();
      const replacementHash = await hashSession(replacementToken);
      const replacementExpiresAt = new Date(Date.now() + auth.sessionMaxAgeSeconds * 1000);
      const acceptance = await auth.store.acceptInvitation({
        sessionHash,
        tokenHash,
        replacementSessionHash: replacementHash,
        replacementExpiresAt,
      });
      if (!acceptance) throw new ApiError(400, "invalid_invitation", "Invalid invitation");
      const session = acceptance.session;
      const response = context.json({
        account: { id: session.accountId, role: session.role },
        user: { id: session.userId },
      });
      if (acceptance.rotated) {
        addCookie(
          response,
          cookieHeader(sessionCookieName, replacementToken, auth.sessionMaxAgeSeconds, secure),
        );
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "invalid_invitation", "Invalid invitation");
    }
  });

  const listAccounts = async (context: Context<ApiRequestEnv>) => {
    const token = readSessionToken(context.req.raw, sessionCookieName);
    if (!token || !auth.store.listAccounts) {
      throw new ApiError(401, "unauthorized", "Authentication required");
    }
    const accounts = await auth.store.listAccounts(await hashSession(token));
    return context.json(accountListResponseSchema.parse({ accounts }));
  };
  api.get("/api/v1/accounts", listAccounts);
  api.get("/api/v1/account", listAccounts);

  api.post("/api/v1/account/switch", async (context) => {
    try {
      const token = readSessionToken(context.req.raw, sessionCookieName);
      if (!token || !auth.store.switchAccount) {
        throw new ApiError(401, "unauthorized", "Authentication required");
      }
      const body = accountSwitchSchema.parse(await context.req.json());
      const replacementToken = randomToken();
      const session = await auth.store.switchAccount({
        sessionHash: await hashSession(token),
        targetAccountId: body.accountId,
        replacementSessionHash: await hashSession(replacementToken),
        replacementExpiresAt: new Date(Date.now() + auth.sessionMaxAgeSeconds * 1000),
      });
      if (!session) throw new ApiError(403, "membership_required", "Membership required");
      const response = context.json({
        account: { id: session.accountId, role: session.role },
        user: { id: session.userId },
      });
      addCookie(
        response,
        cookieHeader(sessionCookieName, replacementToken, auth.sessionMaxAgeSeconds, secure),
      );
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "active_account_required", "Invalid account switch");
    }
  });

  api.get("/api/v1/auth/me", async (context) => {
    try {
      const token = readSessionToken(context.req.raw, sessionCookieName);
      if (!token) throw new ApiError(401, "unauthorized", "Authentication required");
      const currentHash = await hashSession(token);
      const session = await auth.store.resolveSession(currentHash);
      if (!session) throw new ApiError(401, "unauthorized", "Authentication required");
      const replacementToken = randomToken();
      const replacementHash = await hashSession(replacementToken);
      const replacementExpiresAt = new Date(Date.now() + auth.sessionMaxAgeSeconds * 1000);
      const rotated = await auth.store.rotateSession({
        currentSessionHash: currentHash,
        replacementSessionHash: replacementHash,
        replacementExpiresAt,
      });
      if (!rotated) throw new ApiError(401, "unauthorized", "Authentication required");
      const response = context.json({
        user: { id: session.userId, email: session.email },
        account: {
          id: session.accountId,
          role: session.role,
          plan: session.plan,
          iaEnabled: session.iaEnabled,
        },
      });
      addCookie(
        response,
        cookieHeader(sessionCookieName, replacementToken, auth.sessionMaxAgeSeconds, secure),
      );
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "auth_unavailable", "Authentication unavailable");
    }
  });
}

async function hashInvitationBody(token: string): Promise<string> {
  return hashSession(token);
}

export const mountAuthRoutes = registerAuthRoutes;

export { OAUTH_COOKIE, SESSION_COOKIE };
