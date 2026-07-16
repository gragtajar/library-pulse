// @ts-check
/**
 * POST /api/webhook — receives Figma `LIBRARY_PUBLISH` events.
 *
 * Pipeline:
 *   1. Method + event-type checks (answer PING, ignore other types).
 *   2. Look up the webhook row by `webhook_id` and verify the passcode with a
 *      constant-time compare. The row is bound to the user + file that
 *      registered it, so a valid passcode can only ever post to *that user's*
 *      config for *that file* — never across tenants.
 *   3. Look up active configs for (webhook owner, file).
 *   4. Fan out to each channel with bounded concurrency, deduped per channel so
 *      a Figma retry after a partial send re-drives only the missing channels.
 *
 * This endpoint never sets CORS — Figma calls it server-to-server.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import supabase from "../lib/supabase.js";
import { decrypt } from "../lib/encryption.js";
import { buildSlackBlocks, fallbackText } from "../lib/slack-blocks.js";
import { deriveEventKey, hasSentDelivery } from "../lib/idempotency.js";
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
      return res.status(200).json({ status: "ok", service: "library-pulse-webhook" });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    /** @type {any} */
    const payload = req.body ?? {};

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

    if (!payload.webhook_id) {
      logger.warn("webhook_missing_webhook_id");
      return res.status(403).json({ error: "Missing webhook_id" });
    }

    // ── Passcode + tenant binding ──
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
      .select("passcode, status, figma_user_id, context_id")
      .eq("webhook_id", String(payload.webhook_id))
      .maybeSingle();

    if (!wh) {
      logger.warn("webhook_unknown_id", { webhook_id: payload.webhook_id });
      return res.status(403).json({ error: "Unknown webhook" });
    }
    if (wh.status !== "active") {
      logger.warn("webhook_not_active", { webhook_id: payload.webhook_id });
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!supplied || !timingSafeEqualStrings(String(supplied), wh.passcode)) {
      logger.warn("webhook_passcode_mismatch", { webhook_id: payload.webhook_id });
      return res.status(403).json({ error: "Forbidden" });
    }
    // The webhook is file-scoped; the published file must match the one it was
    // registered for. Guards against a stale/cross-file event being honored.
    if (wh.context_id && wh.context_id !== fileKey) {
      logger.warn("webhook_file_mismatch", { webhook_id: payload.webhook_id });
      return res.status(200).json({ status: "ignored", reason: "file_mismatch" });
    }

    const eventKey = deriveEventKey(payload);

    // ── Look up the file's active config (org-shared: one config per file) ──
    // The webhook is file-scoped and its passcode was just verified, so the file
    // key is the authority here — not the registrant. `webhook_id`/passcode bind
    // the request to this exact file; the config is whichever active one targets
    // that file. (Deactivated configs are skipped, so a torn-down setup no-ops.)
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

    /** @type {Array<{configId: string, sent: number, failed: number, skipped: number}>} */
    const allResults = [];

    for (const config of configs) {
      const tokenEnc = /** @type {any} */ (config.slack_installations)?.bot_token_enc;
      if (!tokenEnc) {
        logger.warn("webhook_config_missing_token", { config_id: config.id });
        allResults.push({ configId: config.id, sent: 0, failed: 0, skipped: 0 });
        continue;
      }

      /** @type {string} */
      let botToken;
      try {
        botToken = decrypt(tokenEnc);
      } catch {
        logger.error("webhook_token_decrypt_failed", { config_id: config.id });
        allResults.push({ configId: config.id, sent: 0, failed: 0, skipped: 0 });
        continue;
      }

      const channels = /** @type {Array<{id?: string}|string>} */ (config.channels) ?? [];
      const channelIds = channels
        .map((c) => (typeof c === "string" ? c : c?.id))
        .filter((x) => typeof x === "string");

      let sent = 0;
      let failed = 0;
      let skipped = 0;

      // Skip channels already delivered for this exact event (retry-safe).
      /** @type {string[]} */
      const pending = [];
      for (const channelId of channelIds) {
        if (await hasSentDelivery(eventKey, config.id, channelId)) skipped++;
        else pending.push(channelId);
      }

      for (const chunk of chunked(pending, SLACK_POST_CONCURRENCY)) {
        const results = await Promise.allSettled(
          chunk.map((channelId) =>
            postToSlack(botToken, channelId, text, blocks, config.id, fileKey, eventKey),
          ),
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
        skipped,
        total: channelIds.length,
      });
      allResults.push({ configId: config.id, sent, failed, skipped });
    }

    return res.status(200).json({ status: "processed", results: allResults });
  },
);

/**
 * Post one Slack message and persist the result to `notification_log`
 * (including `event_key`, which is what makes per-channel dedupe work).
 *
 * @param {string} botToken
 * @param {string} channelId
 * @param {string} text
 * @param {any[]} blocks
 * @param {string} configId
 * @param {string} fileKey
 * @param {string} eventKey
 */
async function postToSlack(botToken, channelId, text, blocks, configId, fileKey, eventKey) {
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
    event_key: eventKey,
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
 * Constant-time string compare with no length side channel: both inputs are
 * SHA-256'd to a fixed 32 bytes before comparison, so neither the equality nor
 * the *length* of the secret leaks via timing.
 *
 * @param {string} a
 * @param {string} b
 */
function timingSafeEqualStrings(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}
