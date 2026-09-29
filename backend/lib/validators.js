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
 * `{ id, name?, is_private? }` objects. `is_private` is persisted so the
 * plugin can mark private channels on its chips; when present it must be a
 * real boolean. Clients that omit it (older plugin builds) are unaffected.
 *
 * @param {unknown} v
 * @returns {Array<{ id: string, name?: string, is_private?: boolean }>}
 */
export function assertChannelList(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 3) {
    throw new ValidationError("Provide between 1 and 3 Slack channels");
  }
  return v.map((entry) => {
    const id = typeof entry === "string" ? entry : entry?.id;
    assertSlackChannelId(id);
    /** @type {{ id: string, name?: string, is_private?: boolean }} */
    const channel = { id };
    if (typeof entry === "object" && entry) {
      if (typeof entry.name === "string" && entry.name) channel.name = entry.name;
      if (entry.is_private !== undefined) {
        if (typeof entry.is_private !== "boolean") {
          throw new ValidationError("Channel is_private must be true or false");
        }
        channel.is_private = entry.is_private;
      }
    }
    return channel;
  });
}

/** Notification destinations a file config can target (migration 006). */
const DESTINATIONS = new Set(["slack", "email"]);

/**
 * Validate the destination. Absent (older plugin builds) means Slack, which is
 * the only destination those builds know about.
 *
 * @param {unknown} v
 * @returns {"slack" | "email"}
 */
export function assertDestination(v) {
  if (v == null) return "slack";
  if (typeof v !== "string" || !DESTINATIONS.has(v)) {
    throw new ValidationError("Destination must be 'slack' or 'email'");
  }
  return /** @type {"slack" | "email"} */ (v);
}

// Email addresses: the shape browsers accept for <input type="email"> (the
// WHATWG HTML "valid e-mail address" grammar), plus two practical rules that
// grammar leaves out — the domain must have at least one dot (a bare host
// can't receive mail from the internet) and the RFC 5321 length caps apply
// (64-char local part, 254-char address). Keep in sync with `isValidEmail`
// in figma-plugin/ui.html; tests/email-validation-parity.test.js pins it.
const EMAIL_LOCAL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
// A domain label: 1–63 letters, digits or hyphens, not starting or ending
// with a hyphen (checked separately to keep the pattern linear).
const EMAIL_DOMAIN_LABEL = /^[a-zA-Z0-9-]{1,63}$/;
export const EMAIL_RECIPIENTS_MAX = 5;

/**
 * @param {unknown} v
 * @returns {boolean}
 */
export function isValidEmail(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 254) return false;
  const at = v.lastIndexOf("@");
  if (at < 1 || at === v.length - 1) return false;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (local.length > 64 || !EMAIL_LOCAL.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  return labels.every(
    (label) => EMAIL_DOMAIN_LABEL.test(label) && !label.startsWith("-") && !label.endsWith("-"),
  );
}

/**
 * Canonical form for storage and comparison: trimmed and lower-cased. (Mail
 * systems treat local parts case-insensitively in practice; storing one
 * spelling is what makes the 5-address cap and dedupe honest.)
 *
 * @param {string} v
 * @returns {string}
 */
export function normalizeEmail(v) {
  return v.trim().toLowerCase();
}

/**
 * Validate the email destination's recipient list: 1–5 well-formed addresses,
 * normalized and de-duplicated (order preserved).
 *
 * @param {unknown} v
 * @returns {string[]}
 */
export function assertEmailList(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > EMAIL_RECIPIENTS_MAX) {
    throw new ValidationError(`Provide between 1 and ${EMAIL_RECIPIENTS_MAX} email addresses`);
  }
  /** @type {string[]} */
  const out = [];
  for (const entry of v) {
    if (typeof entry !== "string") throw new ValidationError("Email addresses must be strings");
    const email = normalizeEmail(entry);
    if (!isValidEmail(email)) {
      throw new ValidationError(`Invalid email address: ${email.slice(0, 80)}`);
    }
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

/**
 * Validate an IANA timezone name (e.g. "Asia/Kolkata"). The shape check keeps
 * junk out of the database; the Intl probe is the real test — it accepts
 * every zone the runtime can format in (aliases included) and throws a
 * RangeError for anything else.
 *
 * @param {unknown} v
 * @returns {string}
 */
export function assertTimezone(v) {
  if (typeof v !== "string" || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(v)) {
    throw new ValidationError("Invalid timezone");
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: v });
  } catch {
    throw new ValidationError("Unknown timezone");
  }
  return v;
}

// Exported for tests.
export const _patterns = {
  SLACK_CHANNEL_ID,
  FIGMA_FILE_KEY,
  FIGMA_NUMERIC_ID,
  UUID_V4,
  SLACK_USER_ID,
  SLACK_USERGROUP_ID,
  EMAIL_LOCAL,
  EMAIL_DOMAIN_LABEL,
};
