// @ts-check
/**
 * GET /api/slack/channels — list a workspace's channels for the picker (§5a).
 *
 *   ?fileKey=X     → use the Slack workspace of that file's existing config.
 *   ?slackTeamId=Y → use that workspace directly (first-time setup, right after
 *                    the Slack OAuth completes, before any config exists).
 *
 * Returns `{ channels: [{ id, name, is_private, num_members }] }` sorted by
 * `num_members` desc. Only public channels + private channels the bot is a
 * member of are returned (a Slack limitation) — which is correct, since the bot
 * can only post to those anyway.
 *
 * Auth: `requireSession`. For `?fileKey`, the file's config setter is trusted;
 * any other caller is access-checked (lib/figma-access.js), matching /api/config.
 *
 * No caching: Vercel functions are ephemeral, so we fetch on demand.
 * `conversations.list` is Slack Tier 2 (~20 req/min/workspace); one picker load
 * is at most MAX_PAGES calls.
 */

import supabase from "../../lib/supabase.js";
import { decrypt } from "../../lib/encryption.js";
import { applyCors, fetchWithTimeout, withErrorHandling } from "../../lib/http.js";
import { logger } from "../../lib/logger.js";
import { requireSession } from "../../lib/session.js";
import { NotFoundError, UpstreamError, ValidationError } from "../../lib/errors.js";
import { assertFigmaFileKey } from "../../lib/validators.js";
import { assertFileAccess } from "../../lib/figma-access.js";
import { normalizeChannels } from "../../lib/slack-channels.js";

const PAGE_LIMIT = 200;
const MAX_PAGES = 5; // up to 1000 channels

export default withErrorHandling(
  /**
   * @param {import("../../lib/types.js").VercelRequest} req
   * @param {import("../../lib/types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const callerId = requireSession(req);
    const teamId = await resolveTeamId(
      callerId,
      single(req.query.fileKey),
      single(req.query.slackTeamId),
    );
    const botToken = await getBotToken(teamId);

    const channels = await listAllChannels(botToken);
    return res.status(200).json({ channels });
  },
);

/**
 * @param {string} callerId
 * @param {string} fileKey
 * @param {string} slackTeamId
 * @returns {Promise<string>}
 */
async function resolveTeamId(callerId, fileKey, slackTeamId) {
  if (fileKey) {
    assertFigmaFileKey(fileKey);
    const { data: cfg } = await supabase
      .from("configurations")
      .select("slack_team_id, created_by")
      .eq("figma_file_key", fileKey)
      .maybeSingle();
    if (!cfg) throw new NotFoundError("config_not_found");
    // Trust the setter; access-check other users (same rule as /api/config).
    if (cfg.created_by !== callerId) await assertFileAccess(callerId, fileKey);
    return cfg.slack_team_id;
  }
  if (slackTeamId) return slackTeamId;
  throw new ValidationError("Provide fileKey or slackTeamId");
}

/**
 * @param {string} slackTeamId
 * @returns {Promise<string>}
 */
async function getBotToken(slackTeamId) {
  const { data: inst } = await supabase
    .from("slack_installations")
    .select("bot_token_enc")
    .eq("slack_team_id", slackTeamId)
    .maybeSingle();
  if (!inst || !inst.bot_token_enc) throw new NotFoundError("slack_not_connected");
  return decrypt(inst.bot_token_enc);
}

/**
 * Page through conversations.list and collect public + accessible private
 * channels.
 *
 * @param {string} botToken
 * @returns {Promise<Array<{id: string, name: string, is_private: boolean, num_members: number}>>}
 */
async function listAllChannels(botToken) {
  /** @type {any[]} */
  const raw = [];
  let cursor = "";

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    const r = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      timeoutMs: 8_000,
    });
    /** @type {any} */
    const data = await r.json();

    if (!data.ok) {
      logger.warn("slack_conversations_list_failed", { error: data.error });
      if (["token_revoked", "invalid_auth", "account_inactive"].includes(data.error)) {
        throw new ValidationError("slack_reauth_required");
      }
      throw new UpstreamError(`slack_error:${String(data.error).slice(0, 60)}`);
    }

    if (Array.isArray(data.channels)) raw.push(...data.channels);

    cursor = data.response_metadata?.next_cursor || "";
    if (!cursor) break;
  }
  return normalizeChannels(raw);
}

/** @param {string | string[] | undefined} v */
function single(v) {
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "";
}
