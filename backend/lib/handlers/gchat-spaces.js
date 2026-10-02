// @ts-check
/**
 * GET /api/gchat/spaces — the spaces the signed-in Google account belongs
 * to, for the picker.
 *
 *   ?installationId=X → an account the caller connected (first-time setup,
 *                       right after the sign-in completes).
 *   ?fileKey=Y        → the account on that file's existing config (setter
 *                       trusted, others access-checked).
 *
 * Returns `{ spaces: [{ name, displayName }], truncated? }`, sorted by name.
 * Only named spaces are listed (`spaceType = "SPACE"`): group chats and DMs
 * have no name to pick by. A revoked Google grant surfaces as
 * `google_reauth_required` so the plugin can offer a reconnect.
 */
import { applyCors, withErrorHandling } from "../http.js";
import { requireSession } from "../session.js";
import { UpstreamError, ValidationError } from "../errors.js";
import { resolveInstallation, userAccessToken } from "../google-installations.js";
import { ChatApiError, listSpaces } from "../google-chat.js";

export default withErrorHandling(
  /**
   * @param {import("../types.js").VercelRequest} req
   * @param {import("../types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const callerId = requireSession(req);
    const inst = await resolveInstallation(callerId, {
      fileKey: single(req.query.fileKey),
      installationId: single(req.query.installationId),
    });

    /** @type {string} */
    let token;
    try {
      token = await userAccessToken(inst);
    } catch (err) {
      if (err instanceof UpstreamError && err.message === "google_revoked") {
        throw new ValidationError("google_reauth_required");
      }
      throw err;
    }

    try {
      const { spaces, truncated } = await listSpaces(token);
      const list = spaces
        .map((s) => ({ name: s.name, displayName: s.displayName || s.name }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      return res.status(200).json({ spaces: list, ...(truncated ? { truncated: true } : {}) });
    } catch (err) {
      if (err instanceof ChatApiError && err.status === 401) {
        throw new ValidationError("google_reauth_required");
      }
      throw new UpstreamError(err instanceof Error ? err.message : "chat_api_error");
    }
  },
);

/** @param {string | string[] | undefined} v */
function single(v) {
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "";
}
