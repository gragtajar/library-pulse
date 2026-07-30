// @ts-check
/**
 * Resolve which Slack workspace a plugin request targets and decrypt its bot
 * token. Shared by the channel picker and the mention picker endpoints.
 *
 *   fileKey     → the workspace of that file's existing config (the config
 *                 setter is trusted; any other caller is access-checked with
 *                 their own Figma token — same rule as /api/config).
 *   slackTeamId → that workspace directly (first-time setup, right after the
 *                 Slack OAuth completes, before any config exists).
 */

import supabase from "./supabase.js";
import { decrypt } from "./encryption.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { assertFigmaFileKey } from "./validators.js";
import { assertFileAccess } from "./figma-access.js";

/**
 * @param {string} callerId  verified Figma user id (from the session token)
 * @param {string} fileKey   optional — target an existing config's workspace
 * @param {string} slackTeamId optional — target a workspace directly
 * @returns {Promise<{ teamId: string, botToken: string }>}
 */
export async function resolveWorkspaceToken(callerId, fileKey, slackTeamId) {
  let teamId = "";
  if (fileKey) {
    assertFigmaFileKey(fileKey);
    const { data: cfg } = await supabase
      .from("configurations")
      .select("slack_team_id, created_by")
      .eq("figma_file_key", fileKey)
      .maybeSingle();
    if (!cfg) throw new NotFoundError("config_not_found");
    if (cfg.created_by !== callerId) await assertFileAccess(callerId, fileKey);
    teamId = cfg.slack_team_id;
  } else if (slackTeamId) {
    teamId = slackTeamId;
  } else {
    throw new ValidationError("Provide fileKey or slackTeamId");
  }

  const { data: inst } = await supabase
    .from("slack_installations")
    .select("bot_token_enc")
    .eq("slack_team_id", teamId)
    .maybeSingle();
  if (!inst || !inst.bot_token_enc) throw new NotFoundError("slack_not_connected");
  return { teamId, botToken: decrypt(inst.bot_token_enc) };
}
