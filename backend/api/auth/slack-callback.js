// @ts-check
/**
 * GET /api/auth/slack-callback
 *
 * Slack redirects here after the user authorizes the OAuth app.
 * Exchanges the code for a bot token, stores it AES-encrypted, marks the
 * session as completed, and renders a small status page.
 *
 * Security boundary: the `?error=` and any other query parameter are
 * untrusted strings — they are reflected only via `renderResultPage`
 * which HTML-escapes everything.
 */

import { encrypt } from "../../lib/encryption.js";
import supabase from "../../lib/supabase.js";
import { logger } from "../../lib/logger.js";
import { renderResultPage } from "../../lib/oauth-result-page.js";
import { claimAuthSession, finalizeAuthSession } from "../../lib/auth-session.js";
import { assertUuid } from "../../lib/validators.js";
import { fetchWithTimeout, withErrorHandling } from "../../lib/http.js";
import { UpstreamError, ValidationError } from "../../lib/errors.js";

export default withErrorHandling(
  /**
   * @param {import("../../lib/types.js").VercelRequest} req
   * @param {import("../../lib/types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const code = single(req.query.code);
    const state = single(req.query.state);
    const oauthError = single(req.query.error);

    // ── User denied or Slack sent an error ──
    if (oauthError) {
      if (state) await finalizeAuthSession(state, "failed", { error: oauthError });
      return renderResultPage(res, { success: false, message: "Authorization was denied." });
    }

    if (!code || !state) {
      return renderResultPage(res, { success: false, message: "Missing code or state." });
    }

    try {
      assertUuid(state);
    } catch {
      return renderResultPage(res, { success: false, message: "Invalid state parameter." });
    }

    // Validate the session row exists, isn't expired, isn't already used.
    await claimAuthSession(state, "slack");

    const redirectUri = buildRedirectUri();
    const tokenRes = await fetchWithTimeout("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: envOrThrow("SLACK_CLIENT_ID"),
        client_secret: envOrThrow("SLACK_CLIENT_SECRET"),
        code,
        redirect_uri: redirectUri,
      }),
      timeoutMs: 10_000,
    });

    /** @type {any} */
    const tokenData = await tokenRes.json();

    if (!tokenData.ok) {
      logger.warn("slack_token_exchange_failed", { upstream_error: tokenData.error });
      await finalizeAuthSession(state, "failed", { error: tokenData.error });
      // Don't surface Slack's raw error string to a browser — could echo
      // sensitive details. Keep the user-facing message generic.
      return renderResultPage(res, {
        success: false,
        message: "Slack rejected the authorization. Please try again.",
      });
    }

    const teamId = tokenData.team?.id;
    const teamName = tokenData.team?.name;

    if (!teamId || typeof tokenData.access_token !== "string") {
      throw new UpstreamError("slack_response_missing_fields");
    }

    const { error: dbErr } = await supabase.from("slack_installations").upsert(
      {
        slack_team_id: teamId,
        slack_team_name: teamName ?? null,
        bot_token_enc: encrypt(tokenData.access_token),
        bot_user_id: tokenData.bot_user_id ?? null,
        installing_user: tokenData.authed_user?.id ?? null,
        scopes: tokenData.scope ?? null,
      },
      { onConflict: "slack_team_id" },
    );

    if (dbErr) {
      logger.error("slack_install_persist_failed", { err: dbErr });
      await finalizeAuthSession(state, "failed", { error: "database_error" });
      return renderResultPage(res, { success: false, message: "Failed to save credentials." });
    }

    await finalizeAuthSession(state, "completed", {
      slack_team_id: teamId,
      slack_team_name: teamName,
    });

    logger.info("slack_oauth_completed", { slack_team_id: teamId });
    return renderResultPage(res, {
      success: true,
      message: `Connected to ${teamName ?? "your workspace"}.`,
    });
  },
);

/**
 * @param {string | string[] | undefined} v
 * @returns {string | undefined}
 */
function single(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

/** @param {string} name */
function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new ValidationError(`Missing env: ${name}`);
  return v;
}

function buildRedirectUri() {
  return `${envOrThrow("PUBLIC_URL")}/api/auth/slack-callback`;
}
