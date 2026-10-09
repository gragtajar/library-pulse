// @ts-check
/**
 * GET /api/gchat/callback — Google redirects the browser here after the user
 * signs in and consents. Exchanges the code, checks that both Chat scopes
 * were granted, verifies the ID token, stores the refresh token encrypted
 * (one row per Google account), completes the plugin's auth session and
 * renders a small result page.
 *
 * Security boundary: `?error=` and the other query parameters are untrusted
 * strings; they reach the page only through `renderResultPage`, which escapes
 * everything.
 */
import supabase from "../supabase.js";
import { encrypt } from "../encryption.js";
import { logger } from "../logger.js";
import { renderResultPage } from "../oauth-result-page.js";
import { claimAuthSession, finalizeAuthSession } from "../auth-session.js";
import { assertUuid } from "../validators.js";
import { withErrorHandling } from "../http.js";
import { UpstreamError } from "../errors.js";
import {
  exchangeGoogleCode,
  hasRequiredGoogleScopes,
  verifyGoogleIdToken,
} from "../google-oauth.js";

export default withErrorHandling(
  /**
   * @param {import("../types.js").VercelRequest} req
   * @param {import("../types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const code = single(req.query.code);
    const state = single(req.query.state);
    const oauthError = single(req.query.error);

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

    // Exists, pending, unused, unexpired — or 403.
    const session = await claimAuthSession(state, "google");

    /** @type {Awaited<ReturnType<typeof exchangeGoogleCode>>} */
    let tokens;
    try {
      tokens = await exchangeGoogleCode(code);
    } catch {
      await finalizeAuthSession(state, "failed", { error: "token_exchange_failed" });
      return renderResultPage(res, {
        success: false,
        message: "Google rejected the authorization. Please try again.",
      });
    }

    // The consent screen gives each Chat scope its own checkbox, and Google
    // offers no way to pre-select them; without both nothing downstream
    // works, so say so now, with the way back, rather than at the picker.
    if (!hasRequiredGoogleScopes(tokens.scope)) {
      await finalizeAuthSession(state, "failed", { error: "scopes_declined" });
      return renderResultPage(res, {
        success: false,
        message:
          "Library Pulse needs both Google Chat permissions: one lists your spaces, the other lets it add itself to the spaces you pick. Go back to Figma, click Sign in with Google again and select all the permissions Google lists.",
      });
    }
    if (!tokens.refreshToken) {
      await finalizeAuthSession(state, "failed", { error: "no_refresh_token" });
      return renderResultPage(res, {
        success: false,
        message: "Google didn't return a long-lived token. Please try again.",
      });
    }
    if (!tokens.idToken) throw new UpstreamError("google_response_missing_id_token");

    const who = await verifyGoogleIdToken(tokens.idToken);

    const { data: inst, error: dbErr } = await supabase
      .from("google_installations")
      .upsert(
        {
          google_sub: who.sub,
          google_email: who.email,
          google_hd: who.hd,
          figma_user_id: session.figma_user_id,
          refresh_token_enc: encrypt(tokens.refreshToken),
          scopes: tokens.scope,
          revoked_at: null,
        },
        { onConflict: "google_sub" },
      )
      .select("id")
      .single();
    if (dbErr || !inst) {
      logger.error("google_install_persist_failed", { err: dbErr });
      await finalizeAuthSession(state, "failed", { error: "database_error" });
      return renderResultPage(res, { success: false, message: "Failed to save credentials." });
    }

    // Reconnecting clears a prior google_revoked / send_failing flag on this
    // account's configs. Best-effort — never blocks the callback.
    await supabase
      .from("configurations")
      .update({ delivery_status: "ok", last_delivery_error: null })
      .eq("google_installation_id", inst.id)
      .in("delivery_status", ["google_revoked", "send_failing"]);

    await finalizeAuthSession(state, "completed", {
      google_installation_id: inst.id,
      google_email: who.email,
      google_hd: who.hd,
    });

    logger.info("google_oauth_completed", { installation_id: inst.id, hd: who.hd });
    return renderResultPage(res, {
      success: true,
      message: `Connected as ${who.email ?? "your Google account"}. You can return to Figma.`,
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
