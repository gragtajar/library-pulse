// @ts-check
/**
 * GET /api/auth/figma-callback
 *
 * Figma redirects here after the user authorizes the OAuth app.
 * Exchanges the code for access + refresh tokens and stores them encrypted.
 */

import { encrypt } from "../../lib/encryption.js";
import supabase from "../../lib/supabase.js";
import { logger } from "../../lib/logger.js";
import { renderResultPage } from "../../lib/oauth-result-page.js";
import { claimAuthSession, finalizeAuthSession } from "../../lib/auth-session.js";
import { mintSession } from "../../lib/session.js";
import { assertUuid } from "../../lib/validators.js";
import { fetchWithTimeout, withErrorHandling } from "../../lib/http.js";
import { UpstreamError, ValidationError } from "../../lib/errors.js";
import { FIGMA_OAUTH_SCOPES } from "../../lib/figma-oauth.js";

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

    if (oauthError) {
      if (state) await finalizeAuthSession(state, "failed", { error: oauthError });
      return renderResultPage(res, { success: false, message: "Figma authorization was denied." });
    }

    if (!code || !state) {
      return renderResultPage(res, { success: false, message: "Missing code or state." });
    }

    try {
      assertUuid(state);
    } catch {
      return renderResultPage(res, { success: false, message: "Invalid state parameter." });
    }

    const session = await claimAuthSession(state, "figma");

    const tokenRes = await fetchWithTimeout("https://api.figma.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: envOrThrow("FIGMA_CLIENT_ID"),
        client_secret: envOrThrow("FIGMA_CLIENT_SECRET"),
        redirect_uri: `${envOrThrow("PUBLIC_URL")}/api/auth/figma-callback`,
        code,
        grant_type: "authorization_code",
      }),
      timeoutMs: 10_000,
    });

    if (!tokenRes.ok) {
      logger.warn("figma_token_exchange_failed", { status: tokenRes.status });
      await finalizeAuthSession(state, "failed", { error: "token_exchange_failed" });
      return renderResultPage(res, {
        success: false,
        message: "Failed to exchange the Figma authorization code.",
      });
    }

    /** @type {any} */
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in;
    const figmaUserId = tokenData.user_id ?? session.figma_user_id;

    if (typeof accessToken !== "string" || !figmaUserId) {
      throw new UpstreamError("figma_response_missing_fields");
    }

    const expiresAt =
      typeof expiresIn === "number" ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    const { error: dbErr } = await supabase.from("figma_tokens").upsert(
      {
        figma_user_id: figmaUserId,
        access_token_enc: encrypt(accessToken),
        refresh_token_enc: typeof refreshToken === "string" ? encrypt(refreshToken) : null,
        expires_at: expiresAt,
        // Record what was granted so the file-access probe knows whether this
        // token carries webhooks:read (falls back to what we requested).
        scopes:
          typeof tokenData.scope === "string" && tokenData.scope
            ? tokenData.scope
            : FIGMA_OAUTH_SCOPES,
      },
      { onConflict: "figma_user_id" },
    );

    if (dbErr) {
      logger.error("figma_token_persist_failed", { err: dbErr });
      await finalizeAuthSession(state, "failed", { error: "database_error" });
      return renderResultPage(res, {
        success: false,
        message: "Failed to save Figma credentials.",
      });
    }

    // Mint a signed session token bound to this verified Figma user. The
    // plugin polls auth-status, receives it in result_data, and sends it as a
    // bearer token on every config call — replacing the spoofable header.
    const sessionToken = mintSession(figmaUserId);

    await finalizeAuthSession(state, "completed", {
      figma_user_id: figmaUserId,
      session_token: sessionToken,
    });
    logger.info("figma_oauth_completed", { figma_user_id: figmaUserId });
    return renderResultPage(res, { success: true, message: "Figma account connected." });
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
