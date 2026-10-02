// @ts-check
/**
 * Google sign-in for the Google Chat destination: the OAuth 2.0 web-server
 * flow (developers.google.com/identity/protocols/oauth2/web-server).
 *
 * The user signs in from the plugin and grants two Chat scopes; with their
 * token Library Pulse lists the spaces they belong to and adds itself to the
 * ones they pick. Publish updates are then posted by the app itself
 * (lib/google-app-auth.js), never with the user's token.
 *
 * Scopes are declared once here; the plugin never sends them (same rule as
 * lib/slack-oauth.js), so the authorize URL and the consent screen can't
 * drift apart.
 */

import { OAuth2Client } from "google-auth-library";
import { fetchWithTimeout } from "./http.js";
import { UpstreamError, ValidationError } from "./errors.js";
import { logger } from "./logger.js";

// `chat.spaces.readonly`: list the spaces the user is a member of.
// `chat.memberships.app`: add the Library Pulse app to a space the user chose
// ("the calling app", member name users/app). `openid email`: who connected,
// and which Workspace domain (the `hd` claim).
export const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.memberships.app",
];

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** @param {string} name */
export function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new ValidationError(`Missing env: ${name}`);
  return v;
}

/**
 * The origin Google talks to: the custom domain registered with Google
 * (redirect URI, Chat endpoint). Falls back to PUBLIC_URL for setups without
 * one.
 */
export function googlePublicUrl() {
  const v = process.env.GOOGLE_PUBLIC_URL || process.env.PUBLIC_URL;
  if (!v) throw new ValidationError("Missing env: GOOGLE_PUBLIC_URL");
  return v.replace(/\/+$/, "");
}

/** The redirect URI registered on the OAuth client. */
export function googleRedirectUri() {
  return `${googlePublicUrl()}/api/gchat/callback`;
}

/**
 * The authorize URL the plugin opens in the browser. `access_type=offline`
 * asks for a refresh token; `prompt=consent` makes Google issue one again on a
 * reconnect ("The refresh_token is only returned on the first authorization").
 *
 * @param {string} state
 */
export function buildGoogleAuthorizeUrl(state) {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", envOrThrow("GOOGLE_CLIENT_ID"));
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * @typedef {Object} GoogleTokens
 * @property {string} accessToken
 * @property {string | null} refreshToken
 * @property {number} expiresIn  seconds
 * @property {string} scope      granted scopes, space-delimited
 * @property {string | null} idToken
 */

/**
 * Exchange the authorization code for tokens.
 *
 * @param {string} code
 * @returns {Promise<GoogleTokens>}
 */
export async function exchangeGoogleCode(code) {
  const res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: envOrThrow("GOOGLE_CLIENT_ID"),
      client_secret: envOrThrow("GOOGLE_CLIENT_SECRET"),
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
    timeoutMs: 10_000,
  });
  /** @type {any} */
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.access_token !== "string") {
    logger.warn("google_token_exchange_failed", { status: res.status, upstream_error: data.error });
    throw new UpstreamError(`google_token_exchange_failed:${data.error || res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    expiresIn: Number(data.expires_in) || 3600,
    scope: typeof data.scope === "string" ? data.scope : "",
    idToken: typeof data.id_token === "string" ? data.id_token : null,
  };
}

/**
 * A fresh access token from a stored refresh token. Google answers
 * `invalid_grant` once the user revoked access (or, for an app in Testing,
 * seven days after consent); that is surfaced as `google_revoked` so the
 * plugin can offer a reconnect.
 *
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken: string, expiresIn: number }>}
 */
export async function refreshGoogleAccessToken(refreshToken) {
  const res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: envOrThrow("GOOGLE_CLIENT_ID"),
      client_secret: envOrThrow("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
    timeoutMs: 10_000,
  });
  /** @type {any} */
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.access_token !== "string") {
    const code = data.error === "invalid_grant" ? "google_revoked" : "google_refresh_failed";
    logger.warn("google_token_refresh_failed", { status: res.status, upstream_error: data.error });
    throw new UpstreamError(code);
  }
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || 3600 };
}

/**
 * Who signed in: the ID token's `sub` (stable account id), `email` and `hd`
 * (the Workspace domain; absent for consumer accounts). Verified against
 * Google's keys and our client id with google-auth-library.
 *
 * @param {string} idToken
 * @returns {Promise<{ sub: string, email: string | null, hd: string | null }>}
 */
export async function verifyGoogleIdToken(idToken) {
  const clientId = envOrThrow("GOOGLE_CLIENT_ID");
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload || typeof payload.sub !== "string") {
    throw new UpstreamError("google_id_token_invalid");
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === "string" && payload.email_verified ? payload.email : null,
    hd: typeof payload.hd === "string" ? payload.hd : null,
  };
}

/**
 * True when the granted scopes include everything the destination needs.
 * (A user can untick scopes on Google's consent screen.)
 *
 * @param {string} granted  space-delimited
 */
export function hasRequiredGoogleScopes(granted) {
  const have = new Set(
    String(granted || "")
      .split(/\s+/)
      .filter(Boolean),
  );
  return GOOGLE_OAUTH_SCOPES.filter((s) => s.startsWith("https://")).every((s) => have.has(s));
}
