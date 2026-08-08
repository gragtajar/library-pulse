// @ts-check
/**
 * GET /api/slack/mentions — the mention directory for the custom-note
 * composer: workspace members and user groups the author can tag with "@".
 *
 *   ?fileKey=X     → workspace of that file's config (setter trusted, others
 *                    access-checked — via lib/slack-workspace.js).
 *   ?slackTeamId=Y → that workspace directly (first-time setup).
 *
 * Returns `{ users: [{id, name, real_name}], usergroups: [{id, handle, name}],
 * usergroupsUnavailable?: true, truncated?: true }`, alphabetically sorted.
 * `real_name` is included (empty when identical to the display name) so the
 * picker can match a query against either — a person whose display name is
 * "PJ" must still be findable by typing "Piyush Jain".
 *
 * Large-workspace behavior: users.list includes deactivated accounts and bots
 * in its raw pages, so the pager's ~9.6k-record ceiling counts raw entries;
 * humans are filtered afterwards (lib/slack-directory.js normalizeMembers).
 * Partial results are served with `truncated: true`, and the final payload is
 * cached per workspace for a short TTL (migration 005).
 *
 * Scopes: `users:read` (users.list) and `usergroups:read` (usergroups.list).
 * Workspaces that installed before these scopes were added get Slack's
 * `missing_scope` error → surfaced as `slack_reauth_required` so the plugin
 * can prompt "reconnect Slack". User groups are a paid-plan Slack feature —
 * `plan_upgrade_required` degrades to an empty list, not an error.
 */

import { applyCors, fetchWithTimeout, withErrorHandling } from "../../lib/http.js";
import { logger } from "../../lib/logger.js";
import { requireSession } from "../../lib/session.js";
import { UpstreamError, ValidationError } from "../../lib/errors.js";
import { resolveWorkspaceToken } from "../../lib/slack-workspace.js";
import {
  SLACK_AUTH_ERRORS,
  normalizeMembers,
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

    const cached = await readDirectoryCache(teamId, "mentions");
    if (cached) {
      return res
        .status(200)
        .json({ ...cached.payload, ...(cached.truncated ? { truncated: true } : {}) });
    }

    const { records, truncated } = await pageSlackList(botToken, "users.list", {}, "members");
    const users = normalizeMembers(records);
    const { usergroups, unavailable } = await listUsergroups(botToken);

    const payload = {
      users,
      usergroups,
      ...(unavailable ? { usergroupsUnavailable: true } : {}),
    };
    await writeDirectoryCache(teamId, "mentions", payload, truncated);
    return res.status(200).json({ ...payload, ...(truncated ? { truncated: true } : {}) });
  },
);

/**
 * List user groups. Paid-plan-only feature: `plan_upgrade_required` degrades
 * to an empty list instead of failing the whole directory.
 *
 * @param {string} botToken
 * @returns {Promise<{ usergroups: Array<{ id: string, handle: string, name: string }>, unavailable: boolean }>}
 */
async function listUsergroups(botToken) {
  const r = await fetchWithTimeout("https://slack.com/api/usergroups.list", {
    headers: { Authorization: `Bearer ${botToken}` },
    timeoutMs: 8_000,
  });
  /** @type {any} */
  const data = await r.json();

  if (!data.ok) {
    if (data.error === "plan_upgrade_required") {
      return { usergroups: [], unavailable: true };
    }
    logger.warn("slack_usergroups_list_failed", { error: data.error });
    if (typeof data.error === "string" && SLACK_AUTH_ERRORS.has(data.error)) {
      throw new ValidationError("slack_reauth_required");
    }
    throw new UpstreamError(`slack_error:${String(data.error).slice(0, 60)}`);
  }

  /** @type {Array<{ id: string, handle: string, name: string }>} */
  const out = [];
  for (const g of data.usergroups ?? []) {
    if (!g || typeof g.id !== "string" || typeof g.handle !== "string") continue;
    out.push({ id: g.id, handle: g.handle, name: typeof g.name === "string" ? g.name : g.handle });
  }
  out.sort((a, b) => a.handle.localeCompare(b.handle));
  return { usergroups: out, unavailable: false };
}

/** @param {string | string[] | undefined} v */
function single(v) {
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "";
}
