// @ts-check
/**
 * AES-256-GCM token encryption / decryption.
 *
 * Wire format (base64): `iv (12 bytes) || ciphertext || authTag (16 bytes)`
 *
 * `ENCRYPTION_KEY` env var is a 64-character hex string (32 bytes). Generate
 * with `openssl rand -hex 32`.
 *
 * Rotation: see `docs/runbooks/rotate-encryption-key.md` — the wire format
 * has no key id, so rotation requires a one-shot re-encryption batch job.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit IV recommended for GCM
const TAG_LEN = 16; // 128-bit auth tag
const KEY_HEX_LEN = 64;

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== KEY_HEX_LEN || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate with `openssl rand -hex 32`.",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt `plaintext` and return a single base64 string.
 *
 * @param {string} plaintext
 * @returns {string}
 */
export function encrypt(plaintext) {
  if (typeof plaintext !== "string") {
    throw new TypeError("encrypt() expects a string");
  }
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/**
 * Decrypt a base64 string produced by `encrypt`. Throws on tampering — the
 * GCM auth tag check fails, so callers always know if data is mutated.
 *
 * @param {string} combined
 * @returns {string}
 */
export function decrypt(combined) {
  if (typeof combined !== "string" || combined.length === 0) {
    throw new TypeError("decrypt() expects a non-empty base64 string");
  }
  const key = getKey();
  const buf = Buffer.from(combined, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("Ciphertext too short to be valid");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
}
