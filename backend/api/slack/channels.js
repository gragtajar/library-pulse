// @ts-check
/**
 * GET /api/slack/channels — list a workspace's channels for the picker (§5a).
 *
 *   ?fileKey=X     → use the Slack workspace of that file's existing config.
 *   ?slackTeamId=Y → use that workspace directly (first-time setup, right after
 *                    the Slack OAuth completes, before any config exists).
 *
 * Returns `{ channels: [{ id, name, is_private, num_members }], truncated? }`
 * sorted by `num_members` desc. Only public channels + private channels the
 * bot is a member of appear (a Slack limitation) — correct, since the bot can
 * only post to those.
 *
 * Large-workspace behavior: pages up to ~9.6k channels within a wall-clock
 * deadline (lib/slack-directory.js); if a limit is hit the partial list is
 * served with `truncated: true` so the UI can say so. Results are cached per
 * workspace for a short TTL (migration 005) to respect Slack's Tier-2 rate
 * limits when several editors open the picker.
 *
 * Auth: `requireSession`. For `?fileKey`, the file's config setter is trusted;
 * any other caller is access-checked (lib/figma-access.js), matching /api/config.
 */

import { applyCors, withErrorHandling } from "../../lib/http.js";
import { requireSession } from "../../lib/session.js";
import { normalizeChannels } from "../../lib/slack-channels.js";
import { resolveWorkspaceToken } from "../../lib/slack-workspace.js";
import {
  pageSlackList,
  readDirectoryCache,
  writeDirectoryCache,
} from "../../lib/slack-directory.js";

export default withErrorHandling(
  /**
   * @param {import("../../lib/types.js").VercelRequest} req
   * @param {import("../../lib/types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const callerId = requireSession(req);
    const { teamId, botToken } = await resolveWorkspaceToken(
      callerId,
      single(req.query.fileKey),
      single(req.query.slackTeamId),
    );

    const cached = await readDirectoryCache(teamId, "channels");
    if (cached) {
      return res
        .status(200)
        .json({ channels: cached.payload, ...(cached.truncated ? { truncated: true } : {}) });
    }

    const { records, truncated } = await pageSlackList(
      botToken,
      "conversations.list",
      { types: "public_channel,private_channel", exclude_archived: "true" },
      "channels",
    );
    const channels = normalizeChannels(records);

    await writeDirectoryCache(teamId, "channels", channels, truncated);
    return res.status(200).json({ channels, ...(truncated ? { truncated: true } : {}) });
  },
);

/** @param {string | string[] | undefined} v */
function single(v) {
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "";
}
