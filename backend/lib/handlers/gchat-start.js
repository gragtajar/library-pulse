// @ts-check
/**
 * POST /api/gchat/start — begins the Google sign-in for the Google Chat
 * destination. Body: `{ state }` (a UUID v4 the plugin generated; the
 * callback and the plugin's polling use the same value). Returns `{ url }`
 * for the plugin to open in the browser.
 *
 * Unlike the Slack and Figma starts, this one needs the plugin session: the
 * Google account that signs in is bound to the Figma user who asked, and
 * only they may use it to set up a file (lib/google-installations.js).
 */
import supabase from "../supabase.js";
import { applyCors, withErrorHandling } from "../http.js";
import { logger } from "../logger.js";
import { requireSession } from "../session.js";
import { assertUuid } from "../validators.js";
import { ValidationError } from "../errors.js";
import { buildGoogleAuthorizeUrl } from "../google-oauth.js";

export default withErrorHandling(
  /**
   * @param {import("../types.js").VercelRequest} req
   * @param {import("../types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const callerId = requireSession(req);
    const body = /** @type {Record<string, unknown> | null} */ (req.body) ?? {};
    const state = assertUuid(body.state);
    // Fails fast when the Google client isn't configured, before a session row exists.
    const url = buildGoogleAuthorizeUrl(state);

    const { error } = await supabase.from("auth_sessions").upsert(
      {
        state,
        provider: "google",
        figma_user_id: callerId,
        status: "pending",
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        used_at: null,
        result_data: {},
      },
      { onConflict: "state" },
    );
    if (error) {
      logger.error("auth_session_create_failed", { provider: "google", err: error });
      throw new ValidationError(
        `Could not create auth session: ${error.message || error.code || "database error"}`,
      );
    }

    return res.status(200).json({ url });
  },
);
