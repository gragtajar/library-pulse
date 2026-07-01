// @ts-check
/**
 * Stateless session tokens for the plugin → backend API.
 *
 * Why this exists: the original `config` API trusted a self-asserted
 * `X-Figma-User` header as proof of identity. Figma user IDs aren't secret
 * (they appear in webhook payloads), so anyone could read/edit/delete anyone
 * else's configuration by setting that header. This module replaces that with
 * a real bearer credential.
 *
 * After a user completes Figma OAuth (which proves they control that Figma
 * account), the backend mints an HMAC-signed token bound to their Figma user
 * id. The plugin stores it and sends it as `Authorization: Bearer <token>`.
 * `requireSession()` verifies the signature + expiry and returns the verified
 * user id — there is no way for a client to forge an identity.
 *
 * The signing key is derived from `ENCRYPTION_KEY` (domain-separated) so we
 * don't introduce a new secret to deploy. Token format is `<body>.<sig>` where
 * both parts are base64url; `body` is `{ uid, exp }`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthError } from "./errors.js";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Derive a dedicated signing key from ENCRYPTION_KEY (never reuse it raw). */
function signingKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("ENCRYPTION_KEY (64-char hex) is required to sign sessions");
  }
  return createHmac("sha256", Buffer.from(hex, "hex")).update("library-pulse/session/v1").digest();
}

/** @param {Buffer|string} b */
function b64url(b) {
  return Buffer.from(b).toString("base64url");
}

/**
 * Mint a signed session token for a verified Figma user id.
 *
 * @param {string|number} figmaUserId
 * @param {number} [ttlSeconds]
 * @returns {string}
 */
export function mintSession(figmaUserId, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const body = b64url(
    JSON.stringify({
      uid: String(figmaUserId),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  );
  const sig = b64url(createHmac("sha256", signingKey()).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * Verify a session token. Throws `AuthError` on any problem.
 *
 * @param {unknown} token
 * @returns {{ uid: string }}
 */
export function verifySession(token) {
  if (typeof token !== "string" || token.indexOf(".") === -1) {
    throw new AuthError("missing_session");
  }
  const idx = token.indexOf(".");
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  const expected = b64url(createHmac("sha256", signingKey()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError("bad_session_signature");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new AuthError("bad_session_body");
  }
  if (!payload || typeof payload.uid !== "string" || typeof payload.exp !== "number") {
    throw new AuthError("bad_session_payload");
  }
  if (payload.exp * 1000 < Date.now()) {
    throw new AuthError("session_expired");
  }
  return { uid: payload.uid };
}

/**
 * Extract and verify the bearer token from a request. Returns the verified
 * Figma user id.
 *
 * @param {{ headers?: Record<string, unknown> }} req
 * @returns {string}
 */
export function requireSession(req) {
  const raw = req.headers?.["authorization"] ?? req.headers?.["Authorization"];
  const header = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  const match = /^Bearer\s+(.+)$/i.exec(header || "");
  if (!match) throw new AuthError("missing_authorization");
  return verifySession(match[1]).uid;
}
