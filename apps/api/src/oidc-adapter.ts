import type { GoogleCodeExchange, GoogleIdentityClaims, GoogleOidcAdapter } from "./auth";
import {
  ClientSecretPost,
  authorizationCodeGrant,
  discovery,
  type Configuration,
} from "openid-client";

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * The API boundary deliberately depends on this narrow adapter rather than on
 * an HTTP client. The production composition root supplies the openid-client
 * exchange function; unit tests supply a deterministic function and therefore
 * never contact an identity provider.
 */
export type GoogleOidcAdapterOptions = Readonly<{
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  issuer?: string;
  exchangeCode: (input: GoogleCodeExchange) => Promise<GoogleIdentityClaims>;
}>;

export function createGoogleOidcAdapter(options: GoogleOidcAdapterOptions): GoogleOidcAdapter {
  if (options.issuer !== undefined && options.issuer !== GOOGLE_ISSUER) {
    throw new Error("unsupported OIDC issuer");
  }
  if (
    options.clientId.length === 0 ||
    options.redirectUri.length === 0 ||
    options.authorizationEndpoint !== GOOGLE_AUTHORIZATION_ENDPOINT ||
    typeof options.exchangeCode !== "function"
  ) {
    throw new Error("invalid Google OIDC adapter");
  }
  return Object.freeze({
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    authorizationEndpoint: options.authorizationEndpoint,
    exchangeCode: options.exchangeCode,
  });
}

export type OpenIdGoogleOidcAdapterOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  issuer?: string;
  authorizationEndpoint?: string;
  configuration?: Configuration;
}>;

/**
 * Real composition-root adapter. Discovery/token exchange are the only
 * network operations and are intentionally absent from the injected test
 * factory above. openid-client performs issuer, nonce, PKCE, and ID-token
 * signature validation; this adapter only maps its claims to the API contract.
 */
export async function createOpenIdGoogleOidcAdapter(
  options: OpenIdGoogleOidcAdapterOptions,
): Promise<GoogleOidcAdapter> {
  const issuer = options.issuer ?? GOOGLE_ISSUER;
  if (issuer !== GOOGLE_ISSUER) throw new Error("unsupported OIDC issuer");
  const configuration =
    options.configuration ??
    (await discovery(
      new URL(GOOGLE_ISSUER),
      options.clientId,
      undefined,
      ClientSecretPost(options.clientSecret),
    ));
  const discoveredEndpoint = configuration.serverMetadata().authorization_endpoint;
  const authorizationEndpoint = options.authorizationEndpoint ?? discoveredEndpoint;
  if (!authorizationEndpoint) throw new Error("Google authorization endpoint unavailable");
  return createGoogleOidcAdapter({
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    authorizationEndpoint,
    exchangeCode: async ({ code, verifier, nonce, redirectUri }) => {
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", code);
      const tokens = await authorizationCodeGrant(configuration, callbackUrl, {
        pkceCodeVerifier: verifier,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error("Google ID token claims unavailable");
      const audience = Array.isArray(claims.aud) ? claims.aud : String(claims.aud);
      return {
        issuer: String(claims.iss),
        audience,
        subject: String(claims.sub),
        email: typeof claims.email === "string" ? claims.email : "",
        emailVerified: claims.email_verified === true,
        nonce: typeof claims.nonce === "string" ? claims.nonce : "",
      };
    },
  });
}
