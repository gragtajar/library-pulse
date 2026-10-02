// @ts-check
/**
 * Google Chat delivery, the counterpart of lib/email-delivery.js:
 *
 *   ensureAppMemberships  after a config save, add the Library Pulse app to
 *                         the newly chosen spaces with the USER's token.
 *   sendPublishChats      on a publish, post the update to each space as the
 *                         APP, deduped per space via notification_log
 *                         (`recipient` = the space name) so a Figma retry
 *                         re-drives only the spaces that were missed.
 *
 * Neither throws for a per-space failure: both count and report, and the
 * webhook turns the counts into the config's delivery_status.
 */

import supabase from "./supabase.js";
import { logger } from "./logger.js";
import { hasSentEmailDelivery } from "./idempotency.js";
import { addAppToSpace, ChatApiError, postMessage } from "./google-chat.js";
import { AppAuthError, getAppAccessToken } from "./google-app-auth.js";
import { userAccessToken } from "./google-installations.js";
import { buildChatText } from "./gchat-message.js";
import { UpstreamError } from "./errors.js";

/** @typedef {{ name: string, display_name?: string }} ConfigSpace */

/**
 * @typedef {Object} ChatConfig
 * @property {string} id
 * @property {string} figma_file_key
 * @property {unknown} [gchat_spaces]
 * @property {string | null} [gchat_timezone]
 * @property {string | null} [custom_message]
 * @property {string | null} [google_installation_id]
 */

/**
 * @param {unknown} v
 * @returns {ConfigSpace[]}
 */
export function normalizeSpaceList(v) {
  if (!Array.isArray(v)) return [];
  /** @type {ConfigSpace[]} */
  const out = [];
  for (const s of v) {
    const name = typeof s === "string" ? s : s?.name;
    if (typeof name !== "string" || !/^spaces\/[A-Za-z0-9_-]{1,128}$/.test(name)) continue;
    if (out.some((x) => x.name === name)) continue;
    out.push({
      name,
      display_name: typeof s?.display_name === "string" ? s.display_name.slice(0, 128) : "",
    });
  }
  return out;
}

/**
 * Add the app to each space on the user's behalf and record the membership.
 *
 * @param {import("./google-installations.js").GoogleInstallation} installation
 * @param {ConfigSpace[]} spaces
 * @returns {Promise<{ added: number, failed: number, errors: string[] }>}
 */
export async function ensureAppMemberships(installation, spaces) {
  if (spaces.length === 0) return { added: 0, failed: 0, errors: [] };
  /** @type {string} */
  let token;
  try {
    token = await userAccessToken(installation);
  } catch (err) {
    const code = err instanceof UpstreamError ? err.message : "google_token_failed";
    return { added: 0, failed: spaces.length, errors: spaces.map(() => code) };
  }

  let added = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  for (const space of spaces) {
    try {
      await addAppToSpace(token, space.name);
      await rememberSpace(space, { app_member: true, removed_at: null });
      added++;
    } catch (err) {
      failed++;
      const code = err instanceof ChatApiError ? err.code : "unknown";
      errors.push(code);
      logger.warn("gchat_add_app_failed", { space: space.name, code });
    }
  }
  return { added, failed, errors };
}

/**
 * @param {ConfigSpace} space
 * @param {Record<string, unknown>} patch
 */
async function rememberSpace(space, patch) {
  const { error } = await supabase.from("gchat_spaces").upsert(
    {
      space_name: space.name,
      display_name: space.display_name || null,
      space_type: "SPACE",
      last_event_at: new Date().toISOString(),
      ...patch,
    },
    { onConflict: "space_name" },
  );
  if (error) logger.warn("gchat_space_upsert_failed", { space: space.name, err: error });
}

/**
 * Post one publish update to every chosen space that hasn't received this
 * event yet, skipping spaces the app was removed from or that asked to stop.
 *
 * @param {{ config: ChatConfig, payload: Record<string, any>, fileKey: string, eventKey: string }} args
 * @returns {Promise<{ sent: number, failed: number, skipped: number, total: number, errorCodes: string[] }>}
 */
export async function sendPublishChats({ config, payload, fileKey, eventKey }) {
  const spaces = normalizeSpaceList(config.gchat_spaces);
  const total = spaces.length;
  if (total === 0) {
    logger.info("webhook_gchat_no_spaces", { config_id: config.id });
    return { sent: 0, failed: 0, skipped: 0, total, errorCodes: [] };
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  /** @type {string[]} */
  const errorCodes = [];

  // Which spaces still want updates (removed or muted ones are skipped).
  const { data: rows } = await supabase
    .from("gchat_spaces")
    .select("space_name, app_member, muted")
    .in(
      "space_name",
      spaces.map((s) => s.name),
    );
  const state = new Map((rows ?? []).map((r) => [r.space_name, r]));

  /** @type {ConfigSpace[]} */
  const pending = [];
  for (const space of spaces) {
    const st = state.get(space.name);
    if (st && (st.app_member === false || st.muted === true)) {
      skipped++;
      continue;
    }
    if (await hasSentEmailDelivery(eventKey, config.id, space.name)) skipped++;
    else pending.push(space);
  }
  if (pending.length === 0) return { sent, failed, skipped, total, errorCodes };

  /** @type {string} */
  let appToken;
  try {
    appToken = await getAppAccessToken();
  } catch (err) {
    const code = err instanceof AppAuthError ? err.code : "app_auth_failed";
    for (const space of pending) {
      await logDelivery(config, fileKey, eventKey, space.name, code);
      failed++;
      errorCodes.push(code);
    }
    return { sent, failed, skipped, total, errorCodes };
  }

  const text = buildChatText(payload, fileKey, {
    note: config.custom_message ?? null,
    timezone: config.gchat_timezone ?? null,
  });

  for (const space of pending) {
    try {
      await postMessage(appToken, space.name, text, `${eventKey}:${config.id}:${space.name}`);
      await logDelivery(config, fileKey, eventKey, space.name, null);
      sent++;
    } catch (err) {
      const code = err instanceof ChatApiError ? err.code : "unknown";
      await logDelivery(config, fileKey, eventKey, space.name, code);
      // The app is no longer in the space: remember it, so the plugin can say so.
      if (code === "not_found" || code === "permission_denied") {
        await rememberSpace(space, { app_member: false, removed_at: new Date().toISOString() });
      }
      failed++;
      errorCodes.push(code);
      logger.warn("gchat_post_failed", { config_id: config.id, space: space.name, code });
    }
  }

  return { sent, failed, skipped, total, errorCodes };
}

/**
 * @param {ChatConfig} config
 * @param {string} fileKey
 * @param {string} eventKey
 * @param {string} spaceName
 * @param {string | null} errorCode
 */
async function logDelivery(config, fileKey, eventKey, spaceName, errorCode) {
  const { error } = await supabase.from("notification_log").insert({
    configuration_id: config.id,
    figma_file_key: fileKey,
    event_type: "LIBRARY_PUBLISH",
    event_key: eventKey,
    recipient: spaceName,
    status: errorCode ? "failed" : "sent",
    error_message: errorCode ? errorCode.slice(0, 200) : null,
  });
  if (error) logger.warn("gchat_log_insert_failed", { config_id: config.id, err: error });
}
