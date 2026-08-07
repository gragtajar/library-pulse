// @ts-check
/**
 * POST /api/figma/resolve-file — resolve the current file's key from its own
 * published assets.
 *
 * Why this exists: Figma does not expose `figma.fileKey` to public Community
 * plugins (private plugins only), so the plugin cannot know which file it is
 * running in. What the sandbox CAN read are the publish keys of the file's own
 * local components/styles — and the REST API maps any published asset key back
 * to its containing file: GET /v1/{components|component_sets|styles}/:key →
 * `meta.file_key`. That lookup requires the `library_assets:read` scope on the
 * CALLER's token.
 *
 * Request body: `{ candidates: [{ key, type: "style"|"component"|"component_set" }] }`
 * (collected by the sandbox, ≤10). Responses:
 *   - `{ fileKey }` — first candidate that resolves; validated shape.
 *   - `{ fileKey: null, reason: "not_published" }` — no candidate resolved
 *     (library never published, or assets were deleted from the library).
 *   - 400 `figma_reauth_required` — token lacks `library_assets:read` (predates
 *     the scope / pending approval) or is invalid; the UI prompts a reconnect.
 *
 * Trust note: the resolved key comes from Figma's own records for assets that
 * live in the open file — stronger binding than any user-typed value.
 */

import { applyCors, fetchWithTimeout, withErrorHandling } from "../../lib/http.js";
import { logger } from "../../lib/logger.js";
import { requireSession } from "../../lib/session.js";
import { ValidationError } from "../../lib/errors.js";
import { assertAssetCandidates, assertFigmaFileKey } from "../../lib/validators.js";
import { getFigmaAccessToken } from "../../lib/figma-access.js";
import { LIBRARY_ASSETS_SCOPE, scopeGranted } from "../../lib/figma-oauth.js";

const ENDPOINT_BY_TYPE = {
  style: "styles",
  component: "components",
  component_set: "component_sets",
};

export default withErrorHandling(
  /**
   * @param {import("../../lib/types.js").VercelRequest} req
   * @param {import("../../lib/types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const callerId = requireSession(req);
    const body = /** @type {Record<string, unknown> | null} */ (req.body) ?? {};
    const candidates = assertAssetCandidates(body.candidates);

    const { token, scopes } = await getFigmaAccessToken(callerId);
    // Tokens minted before library_assets:read was granted can't perform the
    // lookup — skip doomed upstream calls and tell the UI to reconnect Figma.
    if (!scopeGranted(scopes, LIBRARY_ASSETS_SCOPE)) {
      throw new ValidationError("figma_reauth_required");
    }

    for (const { key, type } of candidates) {
      const url = `https://api.figma.com/v1/${ENDPOINT_BY_TYPE[type]}/${encodeURIComponent(key)}`;
      const r = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 8_000,
      });

      if (r.status === 401 || r.status === 403) {
        // Invalid/revoked token, or the scope isn't actually on it upstream.
        logger.warn("figma_asset_lookup_denied", { status: r.status });
        throw new ValidationError("figma_reauth_required");
      }
      if (!r.ok) continue; // 404 = unpublished/deleted asset → try the next one

      /** @type {any} */
      const data = await r.json();
      const fileKey = data?.meta?.file_key;
      if (typeof fileKey === "string" && fileKey) {
        assertFigmaFileKey(fileKey);
        logger.info("figma_file_resolved", { via: type });
        return res.status(200).json({ fileKey });
      }
    }

    // Every candidate 404'd: the library has never been published (or its
    // assets were removed from the library). The UI shows "publish once" help.
    logger.info("figma_file_unresolved", { tried: candidates.length });
    return res.status(200).json({ fileKey: null, reason: "not_published" });
  },
);
