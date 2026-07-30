// @ts-check
/**
 * GET /api/slack/mentions — the mention directory for the custom-note
 * composer: workspace members and user groups the author can tag with "@".
 *
 *   ?fileKey=X     → workspace of that file's config (setter trusted, others
 *                    access-checked — via lib/slack-workspace.js).
 *   ?slackTeamId=Y → that workspace directly (first-time setup).
 *
 * Returns `{ users: [{id, name}], usergroups: [{id, handle, name}],
 * usergroupsUnavailable?: true }`, alphabetically sorted.
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

const PAGE_LIMIT = 200;
const MAX_PAGES = 5; // up to 1000 members
const SLACK_AUTH_ERRORS = new Set([
  "token_revoked",
  "invalid_auth",
  "account_inactive",
  "missing_scope",
]);

export default withErrorHandling(
  /**
   * @param {import("../../lib/types.js").VercelRequest} req
   * @param {import("../../lib/types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const callerId = requireSession(req);
    const { botToken } = await resolveWorkspaceToken(
      callerId,
      single(req.query.fileKey),
      single(req.query.slackTeamId),
    );

    const users = await listUsers(botToken);
    const { usergroups, unavailable } = await listUsergroups(botToken);

    return res.status(200).json({
      users,
      usergroups,
      ...(unavailable ? { usergroupsUnavailable: true } : {}),
    });
  },
);

/**
 * Page through users.list, keeping only human, active members.
 *
 * @param {string} botToken
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
async function listUsers(botToken) {
  /** @type {Array<{ id: string, name: string }>} */
  const out = [];
  let cursor = "";

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("https://slack.com/api/users.list");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    const r = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      timeoutMs: 8_000,
    });
    /** @type {any} */
    const data = await r.json();
    if (!data.ok) throw slackError("users_list", data.error);

    for (const m of data.members ?? []) {
      if (!m || typeof m.id !== "string") continue;
      if (m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
      const name = m.profile?.display_name || m.profile?.real_name || m.real_name || m.name;
      if (typeof name === "string" && name) out.push({ id: m.id, name });
    }

    cursor = data.response_metadata?.next_cursor || "";
    if (!cursor) break;
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

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
    throw slackError("usergroups_list", data.error);
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

/**
 * @param {string} where
 * @param {unknown} code
 * @returns {Error}
 */
function slackError(where, code) {
  logger.warn(`slack_${where}_failed`, { error: code });
  if (typeof code === "string" && SLACK_AUTH_ERRORS.has(code)) {
    // Includes missing_scope: installs that predate users:read/usergroups:read
    // must reconnect Slack to grant them.
    return new ValidationError("slack_reauth_required");
  }
  return new UpstreamError(`slack_error:${String(code).slice(0, 60)}`);
}

/** @param {string | string[] | undefined} v */
function single(v) {
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "";
}
