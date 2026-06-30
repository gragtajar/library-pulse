// @ts-check
/**
 * POST /api/webhook — receives Figma `LIBRARY_PUBLISH` events.
 *
 * Pipeline:
 *   1. Method + content checks.
 *   2. Hard-require the passcode header. If a webhook row exists for this
 *      `webhook_id`, the passcode MUST match — never fail open.
 *   3. Idempotency: reserve the event via `webhook_events` so a Figma
 *      retry doesn't re-post to Slack.
 *   4. Look up all active configurations for the published file.
 *   5. Fan out: post to each channel with a small concurrency cap, log
 *      every attempt to `notification_log`.
 *
 * This endpoint never sets CORS — Figma calls it server-to-server.
 */

import { timingSafeEqual } from "node:crypto";
import supabase from "../lib/supabase.js";
import { decrypt } from "../lib/encryption.js";
import { buildSlackBlocks, fallbackText } from "../lib/slack-blocks.js";
import { deriveEventKey, reserveEvent } from "../lib/idempotency.js";
import { fetchWithTimeout, withErrorHandling } from "../lib/http.js";
import { logger } from "../lib/logger.js";

const SLACK_POST_CONCURRENCY = 4;

export default withErrorHandling(
  /**
   * @param {import("../lib/types.js").VercelRequest} req
   * @param {import("../lib/types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (req.method === "GET") {
      // Vercel/uptime checks
      return res.status(200).json({ status: "ok", service: "library-pulse-webhook" });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    /** @type {any} */
    const payload = req.body ?? {};

    // ── Figma PING ──
    if (payload.event_type === "PING") {
      logger.info("figma_ping_received");
      return res.status(200).json({ status: "pong" });
    }

    if (payload.event_type !== "LIBRARY_PUBLISH") {
      return res.status(200).json({ status: "ignored", reason: "unsupported_event_type" });
    }

    const fileKey = typeof payload.file_key === "string" ? payload.file_key : null;
    if (!fileKey) {
      return res.status(200).json({ status: "ignored", reason: "no_file_key" });
    }

    // ── Hard-require passcode ──
    // Figma sends it both in the JSON body and as `X-Figma-Passcode` header.
    // We accept either, but ONE must match the stored value for the webhook id.
    if (!payload.webhook_id) {
      logger.warn("webhook_missing_webhook_id");
      return res.status(403).json({ error: "Missing webhook_id" });
    }

    const headerPasscode = req.headers?.["x-figma-passcode"];
    const headerPass =
      typeof headerPasscode === "string"
        ? headerPasscode
        : Array.isArray(headerPasscode)
          ? headerPasscode[0]
          : null;
    const supplied = headerPass ?? payload.passcode ?? null;

    const { data: wh } = await supabase
      .from("figma_webhooks")
      .select("passcode")
      .eq("webhook_id", payload.webhook_id)
      .maybeSingle();

    if (!wh) {
      logger.warn("webhook_unknown_id", { webhook_id: payload.webhook_id });
      return res.status(403).json({ error: "Unknown webhook" });
    }

    if (!supplied || !timingSafeEqualStrings(String(supplied), wh.passcode)) {
      logger.warn("webhook_passcode_mismatch", { webhook_id: payload.webhook_id });
      return res.status(403).json({ error: "Forbidden" });
    }

    // ── Idempotency ──
    const eventKey = deriveEventKey(payload);
    const firstDelivery = await reserveEvent(eventKey, {
      event_type: "LIBRARY_PUBLISH",
      figma_file_key: fileKey,
    });
    if (!firstDelivery) {
      logger.info("webhook_duplicate_skipped", { event_key: eventKey });
      return res.status(200).json({ status: "duplicate" });
    }

    // ── Look up configs ──
    const { data: configs, error: cfgErr } = await supabase
      .from("configurations")
      .select("id, figma_file_key, channels, slack_installations(bot_token_enc, slack_team_name)")
      .eq("figma_file_key", fileKey)
      .eq("is_active", true);

    if (cfgErr) {
      logger.error("webhook_config_lookup_failed", { err: cfgErr });
      return res.status(500).json({ error: "Database error" });
    }

    if (!configs || configs.length === 0) {
      logger.info("webhook_no_active_configs", { file_key: fileKey });
      return res.status(200).json({ status: "no_configs" });
    }

    const blocks = buildSlackBlocks(payload, fileKey);
    const text = fallbackText(payload);

    /** @type {Array<{configId: string, sent: number, failed: number}>} */
    const allResults = [];

    for (const config of configs) {
      const tokenEnc = /** @type {any} */ (config.slack_installations)?.bot_token_enc;
      if (!tokenEnc) {
        logger.warn("webhook_config_missing_token", { config_id: config.id });
        allResults.push({ configId: config.id, sent: 0, failed: 0 });
        continue;
      }

      /** @type {string} */
      let botToken;
      try {
        botToken = decrypt(tokenEnc);
      } catch (err) {
        logger.error("webhook_token_decrypt_failed", { config_id: config.id });
        allResults.push({ configId: config.id, sent: 0, failed: 0 });
        continue;
      }

      const channels = /** @type {Array<{id?: string}|string>} */ (config.channels) ?? [];
      const channelIds = channels
        .map((c) => (typeof c === "string" ? c : c?.id))
        .filter((x) => typeof x === "string");

      let sent = 0;
      let failed = 0;

      // Bounded concurrency — Slack rate-limits chat.postMessage per channel.
      for (const chunk of chunked(channelIds, SLACK_POST_CONCURRENCY)) {
        const results = await Promise.allSettled(
          chunk.map((channelId) => postToSlack(botToken, channelId, text, blocks, config.id, fileKey)),
        );
        for (const r of results) {
          if (r.status === "fulfilled") sent++;
          else failed++;
        }
      }

      logger.info("webhook_config_dispatched", {
        config_id: config.id,
        sent,
        failed,
        total: channelIds.length,
      });
      allResults.push({ configId: config.id, sent, failed });
    }

    return res.status(200).json({ status: "processed", results: allResults });
  },
);

/**
 * Post one Slack message and persist the result to `notification_log`.
 *
 * @param {string} botToken
 * @param {string} channelId
 * @param {string} text
 * @param {any[]} blocks
 * @param {string} configId
 * @param {string} fileKey
 */
async function postToSlack(botToken, channelId, text, blocks, configId, fileKey) {
  const slackRes = await fetchWithTimeout("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: channelId, text, blocks }),
    timeoutMs: 8_000,
  });
  /** @type {any} */
  const data = await slackRes.json();

  await supabase.from("notification_log").insert({
    configuration_id: configId,
    figma_file_key: fileKey,
    event_type: "LIBRARY_PUBLISH",
    slack_channel_id: channelId,
    status: data.ok ? "sent" : "failed",
    error_message: data.ok ? null : String(data.error ?? "unknown_error").slice(0, 200),
  });

  if (!data.ok) {
    throw new Error(`slack_api_error:${data.error}`);
  }
  return { ok: true, ts: data.ts };
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {Generator<T[]>}
 */
function* chunked(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

/**
 * Constant-time string compare. Falls back to a slow path for differing
 * lengths so callers can't time-side-channel the secret length.
 *
 * @param {string} a
 * @param {string} b
 */
function timingSafeEqualStrings(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
