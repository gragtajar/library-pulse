// @ts-check
/**
 * Webhook idempotency — Figma may retry a `LIBRARY_PUBLISH` event if the
 * webhook receiver times out or returns 5xx. Without deduplication, the
 * same publish posts to Slack multiple times.
 *
 * Strategy: derive a stable event key from the payload and INSERT into
 * `webhook_events` with `event_key UNIQUE`. If the insert succeeds, this
 * is the first delivery; if it errors with a unique-constraint violation
 * (PG `23505`), we've already processed it.
 *
 * See database/schema.sql for the `webhook_events` table.
 */

import { createHash } from "node:crypto";
import supabase from "./supabase.js";

const PG_UNIQUE_VIOLATION = "23505";

/**
 * Build a stable key for an incoming Figma webhook payload.
 *
 * Prefer `event_id` when Figma provides one. Otherwise hash the
 * (file_key, timestamp, sorted-changed-items) tuple.
 *
 * @param {Record<string, any>} payload
 * @returns {string}
 */
export function deriveEventKey(payload) {
  if (typeof payload.event_id === "string" && payload.event_id.length > 0) {
    return `figma:${payload.event_id}`;
  }

  /** @param {unknown} a */
  const itemNames = (a) =>
    Array.isArray(a)
      ? a
          .map((x) => (typeof x === "string" ? x : (x?.key ?? x?.name ?? "")))
          .filter(Boolean)
          .sort()
      : [];

  const summary = {
    file_key: payload.file_key ?? null,
    timestamp: payload.timestamp ?? null,
    webhook_id: payload.webhook_id ?? null,
    created: [
      ...itemNames(payload.created_components),
      ...itemNames(payload.created_styles),
      ...itemNames(payload.created_variables),
    ],
    modified: [
      ...itemNames(payload.modified_components),
      ...itemNames(payload.modified_styles),
      ...itemNames(payload.modified_variables),
    ],
    deleted: [
      ...itemNames(payload.deleted_components),
      ...itemNames(payload.deleted_styles),
      ...itemNames(payload.deleted_variables),
    ],
  };

  const hash = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
  return `figma:hash:${hash}`;
}

/**
 * Atomically reserve an event key. Returns `true` if this is the first
 * delivery (caller should proceed), `false` if a duplicate.
 *
 * Retained for the coarse event-level audit table. The webhook handler now
 * dedupes at *channel* granularity (see `hasSentDelivery`) so that a retry
 * after a partial fan-out re-drives only the channels that didn't get the
 * message, instead of either dropping them silently or re-posting the ones
 * that succeeded.
 *
 * @param {string} eventKey
 * @param {{ event_type?: string, figma_file_key?: string }} [meta]
 * @returns {Promise<boolean>}
 */
export async function reserveEvent(eventKey, meta = {}) {
  const { error } = await supabase.from("webhook_events").insert({
    event_key: eventKey,
    event_type: meta.event_type ?? null,
    figma_file_key: meta.figma_file_key ?? null,
  });

  if (!error) return true;

  // Supabase returns `code: '23505'` on unique-constraint violation.
  if (/** @type {any} */ (error).code === PG_UNIQUE_VIOLATION) return false;

  // Any other DB error: re-throw so the handler can return 5xx and Figma
  // will retry. We'd rather double-deliver than silently drop.
  throw new Error(`webhook_events insert failed: ${error.message}`);
}

/**
 * Has this exact (event, config, channel) already been delivered successfully?
 * Used to make webhook delivery idempotent per channel: a Figma retry skips
 * channels already marked `sent` in `notification_log` and re-attempts the
 * rest. (Figma retries are minutes apart, so a check-then-post is safe — there
 * is no concurrent-duplicate window to race.)
 *
 * @param {string} eventKey
 * @param {string} configId
 * @param {string} channelId
 * @returns {Promise<boolean>}
 */
export async function hasSentDelivery(eventKey, configId, channelId) {
  const { data } = await supabase
    .from("notification_log")
    .select("id")
    .eq("event_key", eventKey)
    .eq("configuration_id", configId)
    .eq("slack_channel_id", channelId)
    .eq("status", "sent")
    .limit(1)
    .maybeSingle();
  return !!data;
}
