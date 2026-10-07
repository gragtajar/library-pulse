// @ts-check
/**
 * The Library Pulse app's own Google access token (scope chat.bot), used to
 * post updates as the app. Two documented ways to hold the service account's
 * identity, chosen by what the environment provides:
 *
 *   1. Workload Identity Federation from Vercel's OIDC token (no key stored
 *      anywhere): vercel.com/docs/oidc/gcp. Needs GCP_PROJECT_NUMBER,
 *      GCP_WORKLOAD_IDENTITY_POOL_ID, GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID,
 *      GCP_SERVICE_ACCOUNT_EMAIL, and OIDC federation enabled on the project.
 *   2. A service-account JSON key in GOOGLE_SERVICE_ACCOUNT_KEY (the key
 *      itself, or base64 of it).
 *
 * google-auth-library caches the token and refreshes it before expiry; the
 * client lives for the life of the function instance.
 *
 * Where Vercel's OIDC token comes from: Vercel's docs guarantee it on every
 * invocation as the `x-vercel-oidc-token` request header. @vercel/oidc looks
 * for it in a per-request context instead, and Vercel's open-source Node
 * runtime fills that context with `waitUntil` only. So the webhook hands the
 * header over (`rememberVercelOidcToken`), and the library's own lookup is the
 * fallback.
 */

import { ExternalAccountClient, JWT } from "google-auth-library";
import { getVercelOidcToken } from "@vercel/oidc";
import { logger } from "./logger.js";

export const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

// Three base64url segments: a JWT. Anything else isn't Vercel's token.
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** Vercel's OIDC token for this deployment, as last seen on a request. */
let requestOidcToken = "";

/**
 * Remember the OIDC token Vercel attaches to an invocation. The token names
 * the project and environment, not the caller, and Vercel reuses one token
 * across invocations, so keeping the latest is safe when requests overlap.
 *
 * @param {Record<string, string | string[] | undefined> | undefined} headers
 */
export function rememberVercelOidcToken(headers) {
  const raw = headers?.["x-vercel-oidc-token"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && value.length < 8192 && JWT_SHAPE.test(value)) {
    requestOidcToken = value;
  }
}

/** The subject token for the federation exchange: the header, else the library. */
export async function vercelSubjectToken() {
  if (requestOidcToken) return requestOidcToken;
  return getVercelOidcToken();
}

export class AppAuthError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail) {
    super(`app_auth_error:${code}`);
    this.name = "AppAuthError";
    this.code = code;
    this.detail = detail;
  }
}

/** @type {import("google-auth-library").AuthClient | null} */
let client = null;

/** Which credential source the environment configures, or null. */
export function appAuthMode() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return "key";
  if (
    process.env.GCP_PROJECT_NUMBER &&
    process.env.GCP_WORKLOAD_IDENTITY_POOL_ID &&
    process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID &&
    process.env.GCP_SERVICE_ACCOUNT_EMAIL
  ) {
    return "wif";
  }
  return null;
}

/**
 * @param {{ client?: import("google-auth-library").AuthClient }} [opts]  test seam
 * @returns {Promise<string>}
 */
export async function getAppAccessToken(opts = {}) {
  const auth = opts.client ?? (client ??= buildClient());
  try {
    const { token } = await auth.getAccessToken();
    if (!token) throw new AppAuthError("empty_token");
    return token;
  } catch (err) {
    if (err instanceof AppAuthError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("google_app_auth_failed", { mode: appAuthMode(), detail });
    throw new AppAuthError("app_auth_failed", detail);
  }
}

function buildClient() {
  const mode = appAuthMode();
  if (mode === "key") return keyClient();
  if (mode === "wif") return wifClient();
  throw new AppAuthError("app_auth_unconfigured");
}

function keyClient() {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  /** @type {{ client_email?: string, private_key?: string }} */
  let key;
  try {
    key = JSON.parse(
      raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"),
    );
  } catch {
    throw new AppAuthError("app_auth_key_unreadable");
  }
  if (!key.client_email || !key.private_key) throw new AppAuthError("app_auth_key_incomplete");
  return new JWT({ email: key.client_email, key: key.private_key, scopes: [CHAT_BOT_SCOPE] });
}

function wifClient() {
  const projectNumber = process.env.GCP_PROJECT_NUMBER;
  const pool = process.env.GCP_WORKLOAD_IDENTITY_POOL_ID;
  const provider = process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID;
  const serviceAccount = process.env.GCP_SERVICE_ACCOUNT_EMAIL;
  const external = ExternalAccountClient.fromJSON({
    type: "external_account",
    audience: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
    subject_token_supplier: {
      // Vercel's OIDC token for this deployment (see the note at the top).
      getSubjectToken: () => vercelSubjectToken(),
    },
  });
  if (!external) throw new AppAuthError("app_auth_wif_config");
  external.scopes = [CHAT_BOT_SCOPE];
  return external;
}

/** Test seam: forget the cached client and the remembered token. */
export function _resetAppAuthClient() {
  client = null;
  requestOidcToken = "";
}
