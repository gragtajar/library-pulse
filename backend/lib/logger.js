// @ts-check
/**
 * Structured JSON logger (per v2 §T1). One line per event. No `console.log`.
 *
 * Vercel ingests `stdout`/`stderr` lines as log records. Emitting JSON lets us
 * filter by level, request id, or fields like `figma_team_id` without parsing.
 *
 * Usage:
 *   import { logger } from "../lib/logger.js";
 *   logger.info("config_saved", { configId, figmaUserId });
 *   logger.warn("decrypt_failed", { configId });
 *   logger.error("upstream_error", { url, err });
 */

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL =
  LEVEL_ORDER[/** @type {keyof typeof LEVEL_ORDER} */ (process.env.LOG_LEVEL ?? "info")] ??
  LEVEL_ORDER.info;

// Keys we will never let into a log line, even if the caller passes them.
// Better to drop silently than risk leaking a secret to Vercel's log store.
const REDACT_KEYS = new Set([
  "access_token",
  "refresh_token",
  "bot_token",
  "token",
  "encryption_key",
  "password",
  "secret",
  "client_secret",
  "passcode",
  "authorization",
  "cookie",
]);

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function redact(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message };
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

/**
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
function emit(level, event, fields) {
  if (LEVEL_ORDER[level] < MIN_LEVEL) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? /** @type {Record<string, unknown>} */ (redact(fields)) : {}),
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  /** @param {string} event @param {Record<string, unknown>} [fields] */
  debug: (event, fields) => emit("debug", event, fields),
  /** @param {string} event @param {Record<string, unknown>} [fields] */
  info: (event, fields) => emit("info", event, fields),
  /** @param {string} event @param {Record<string, unknown>} [fields] */
  warn: (event, fields) => emit("warn", event, fields),
  /** @param {string} event @param {Record<string, unknown>} [fields] */
  error: (event, fields) => emit("error", event, fields),
};
