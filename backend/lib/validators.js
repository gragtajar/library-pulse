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

/** Figma published-asset keys (component/style publish keys — hex-ish strings). */
const FIGMA_ASSET_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const ASSET_TYPES = new Set(["style", "component", "component_set"]);
const ASSET_CANDIDATES_MAX = 10;

/**
 * Validate the published-asset candidates the plugin sandbox collected for
 * file-key resolution: 1–10 entries of `{ key, type }`.
 *
 * @param {unknown} v
 * @returns {Array<{ key: string, type: "style" | "component" | "component_set" }>}
 */
export function assertAssetCandidates(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > ASSET_CANDIDATES_MAX) {
    throw new ValidationError(`Provide between 1 and ${ASSET_CANDIDATES_MAX} asset candidates`);
  }
  return v.map((entry) => {
    const key = typeof entry?.key === "string" ? entry.key : "";
    const type = entry?.type;
    if (!FIGMA_ASSET_KEY.test(key)) throw new ValidationError("Invalid Figma asset key");
    if (typeof type !== "string" || !ASSET_TYPES.has(type)) {
      throw new ValidationError("Invalid asset type");
    }
    return { key, type: /** @type {"style" | "component" | "component_set"} */ (type) };
  });
}

/** Slack user IDs (`U…`/`W…`) and user-group IDs (`S…`). */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const SLACK_USERGROUP_ID = /^S[A-Z0-9]{2,20}$/;

const CUSTOM_MESSAGE_MAX = 500;
const MENTION_LABEL_MAX = 80;
const MENTIONS_MAX = 20;

/**
 * Validate the optional per-file custom message. Plain text only (Slack
 * mention tokens are NEVER accepted here — they're built server-side from the
 * validated mention list). Returns the trimmed string, or null when empty.
 *
 * @param {unknown} v
 * @returns {string | null}
 */
export function assertCustomMessage(v) {
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw new ValidationError("Custom message must be a string");
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > CUSTOM_MESSAGE_MAX) {
    throw new ValidationError(`Custom message too long (max ${CUSTOM_MESSAGE_MAX} characters)`);
  }
  return trimmed;
}

/**
 * Validate the picker-chosen mention list stored alongside the custom message.
 * Each entry must be `{ id, type, label }` with a well-formed Slack id for its
 * type — this is what makes server-side token substitution injection-proof.
 *
 * @param {unknown} v
 * @returns {Array<{ id: string, type: "user" | "usergroup", label: string }>}
 */
export function assertMentionList(v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MENTIONS_MAX) {
    throw new ValidationError(`Provide at most ${MENTIONS_MAX} mentions`);
  }
  return v.map((entry) => {
    const id = typeof entry?.id === "string" ? entry.id : "";
    const type = entry?.type;
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    if (type !== "user" && type !== "usergroup") {
      throw new ValidationError("Mention type must be 'user' or 'usergroup'");
    }
    const idOk = type === "user" ? SLACK_USER_ID.test(id) : SLACK_USERGROUP_ID.test(id);
    if (!idOk) throw new ValidationError(`Invalid Slack ${type} ID in mentions`);
    if (!label || label.length > MENTION_LABEL_MAX) {
      throw new ValidationError(`Mention label required (max ${MENTION_LABEL_MAX} characters)`);
    }
    return { id, type, label };
  });
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
  SLACK_USER_ID,
  SLACK_USERGROUP_ID,
};
