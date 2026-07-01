// @ts-check
/**
 * Input validators for boundary parameters.
 *
 * Throw `ValidationError` on bad input — handlers translate that to a
 * 400 response. Never silently coerce.
 */

import { ValidationError } from "./errors.js";

/** Slack channel IDs: public `C…`, private `G…`, DM `D…`, MPIM `MP…`. */
const SLACK_CHANNEL_ID = /^(C|G|D|MP)[A-Z0-9]{6,20}$/;

/** Figma file keys: opaque base62-ish identifiers. */
const FIGMA_FILE_KEY = /^[A-Za-z0-9]{8,40}$/;

/** Figma team / user IDs: numeric strings (Figma's documented format). */
const FIGMA_NUMERIC_ID = /^[0-9]{6,30}$/;

/** UUIDv4-ish (we accept any RFC 4122 UUID for OAuth state). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} v
 * @returns {string}
 */
export function assertSlackChannelId(v) {
  if (typeof v !== "string" || !SLACK_CHANNEL_ID.test(v)) {
    throw new ValidationError(`Invalid Slack channel ID: expected pattern ${SLACK_CHANNEL_ID}`);
  }
  return v;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
export function assertFigmaFileKey(v) {
  if (typeof v !== "string" || !FIGMA_FILE_KEY.test(v)) {
    throw new ValidationError("Invalid Figma file key");
  }
  return v;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
export function assertFigmaTeamId(v) {
  if (typeof v !== "string" || !FIGMA_NUMERIC_ID.test(v)) {
    throw new ValidationError("Invalid Figma team ID — expected a numeric string");
  }
  return v;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
export function assertFigmaUserId(v) {
  if (typeof v !== "string" || !FIGMA_NUMERIC_ID.test(v)) {
    throw new ValidationError("Invalid Figma user ID");
  }
  return v;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
export function assertUuid(v) {
  if (typeof v !== "string" || !UUID_V4.test(v)) {
    throw new ValidationError("Invalid state token (expected UUID v4)");
  }
  return v;
}

/**
 * Validate an array of 1–3 Slack channels. Accepts string IDs or
 * `{ id, name? }` objects.
 *
 * @param {unknown} v
 * @returns {Array<{ id: string, name?: string }>}
 */
export function assertChannelList(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 3) {
    throw new ValidationError("Provide between 1 and 3 Slack channels");
  }
  return v.map((entry) => {
    const id = typeof entry === "string" ? entry : entry?.id;
    assertSlackChannelId(id);
    const name =
      typeof entry === "object" && entry && typeof entry.name === "string" ? entry.name : undefined;
    return name ? { id, name } : { id };
  });
}

// Exported for tests.
export const _patterns = {
  SLACK_CHANNEL_ID,
  FIGMA_FILE_KEY,
  FIGMA_NUMERIC_ID,
  UUID_V4,
};
