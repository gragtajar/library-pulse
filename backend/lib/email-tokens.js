// @ts-check
/**
 * Stateless, signed tokens for the two links an email needs: "confirm this
 * address" (double opt-in) and "unsubscribe".
 *
 * Same construction as lib/session.js — HMAC-SHA256 over a base64url JSON
 * body, key derived from ENCRYPTION_KEY under its own domain separator — so
 * there is no token table to clean up and a link stays valid for exactly as
 * long as it says. Using a link is idempotent: confirming twice or
 * unsubscribing twice changes nothing, so a leaked or re-clicked link can't
 * do anything the first click couldn't.
 *
 * Body: `{ p, c, e, exp }` — purpose code, config id, address, expiry (unix
 * seconds). Confirm links live 7 days; unsubscribe links 400 days, so the
 * footer of an old notification keeps working.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { ValidationError } from "./errors.js";

export const CONFIRM_TTL_SECONDS = 7 * 24 * 60 * 60;
export const UNSUBSCRIBE_TTL_SECONDS = 400 * 24 * 60 * 60;

/** @typedef {"confirm" | "unsubscribe"} EmailTokenPurpose */

const PURPOSE_CODE = /** @type {const} */ ({ confirm: "c", unsubscribe: "u" });

/** Derive a dedicated signing key from ENCRYPTION_KEY (never reuse it raw). */
function signingKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("ENCRYPTION_KEY (64-char hex) is required to sign email links");
  }
  return createHmac("sha256", Buffer.from(hex, "hex"))
    .update("library-pulse/email-links/v1")
    .digest();
}

/** @param {Buffer|string} b */
function b64url(b) {
  return Buffer.from(b).toString("base64url");
}

/**
 * Mint a signed link token.
 *
 * @param {EmailTokenPurpose} purpose
 * @param {string} configId
 * @param {string} email  normalized (lower-cased) address
 * @param {number} [ttlSeconds]
 * @returns {string}
 */
export function mintEmailToken(purpose, configId, email, ttlSeconds) {
  const ttl = ttlSeconds ?? (purpose === "confirm" ? CONFIRM_TTL_SECONDS : UNSUBSCRIBE_TTL_SECONDS);
  const body = b64url(
    JSON.stringify({
      p: PURPOSE_CODE[purpose],
      c: configId,
      e: email,
      exp: Math.floor(Date.now() / 1000) + ttl,
    }),
  );
  const sig = b64url(createHmac("sha256", signingKey()).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * Verify a link token for the given purpose. Throws `ValidationError` with
 * message `email_link_invalid` (bad/forged/wrong purpose) or
 * `email_link_expired`.
 *
 * @param {unknown} token
 * @param {EmailTokenPurpose} purpose
 * @returns {{ configId: string, email: string }}
 */
export function verifyEmailToken(token, purpose) {
  if (typeof token !== "string" || token.length > 1024 || token.indexOf(".") === -1) {
    throw new ValidationError("email_link_invalid");
  }
  const idx = token.indexOf(".");
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  const expected = b64url(createHmac("sha256", signingKey()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ValidationError("email_link_invalid");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new ValidationError("email_link_invalid");
  }
  if (
    !payload ||
    payload.p !== PURPOSE_CODE[purpose] ||
    typeof payload.c !== "string" ||
    typeof payload.e !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new ValidationError("email_link_invalid");
  }
  if (payload.exp * 1000 < Date.now()) {
    throw new ValidationError("email_link_expired");
  }
  return { configId: payload.c, email: payload.e };
}
