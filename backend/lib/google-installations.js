// @ts-check
/**
 * The Google accounts that connected Google Chat (table google_installations,
 * migration 007), and the user access tokens derived from their refresh
 * tokens. The counterpart of lib/slack-workspace.js.
 *
 *   resolveInstallation  which installation a plugin request may use:
 *     fileKey        → the one on that file's existing config (the config
 *                      setter is trusted; any other caller is access-checked
 *                      with their own Figma token — same rule as /api/config).
 *     installationId → one the caller connected themselves (first-time
 *                      setup, right after the sign-in completes).
 *   userAccessToken      a fresh access token for an installation. Google's
 *                      `invalid_grant` marks the installation revoked and
 *                      flags its configs `google_revoked`, so the plugin can
 *                      offer a reconnect.
 */

import supabase from "./supabase.js";
import { decrypt } from "./encryption.js";
import { ForbiddenError, NotFoundError, UpstreamError, ValidationError } from "./errors.js";
import { assertFigmaFileKey, assertUuid } from "./validators.js";
import { assertFileAccess } from "./figma-access.js";
import { refreshGoogleAccessToken } from "./google-oauth.js";
import { logger } from "./logger.js";

/**
 * @typedef {Object} GoogleInstallation
 * @property {string} id
 * @property {string} google_sub
 * @property {string | null} google_email
 * @property {string | null} google_hd
 * @property {string | null} figma_user_id
 * @property {string} refresh_token_enc
 * @property {string | null} revoked_at
 */

const INSTALLATION_COLUMNS =
  "id, google_sub, google_email, google_hd, figma_user_id, refresh_token_enc, revoked_at";

/** Access tokens by installation id, until shortly before they expire. */
const tokenCache = new Map();

/**
 * @param {string} callerId  verified Figma user id (from the session token)
 * @param {{ fileKey?: string, installationId?: string }} by
 * @returns {Promise<GoogleInstallation>}
 */
export async function resolveInstallation(callerId, by) {
  let id = "";
  if (by.fileKey) {
    assertFigmaFileKey(by.fileKey);
    const { data: cfg } = await supabase
      .from("configurations")
      .select("google_installation_id, created_by")
      .eq("figma_file_key", by.fileKey)
      .maybeSingle();
    if (!cfg) throw new NotFoundError("config_not_found");
    if (cfg.created_by !== callerId) await assertFileAccess(callerId, by.fileKey);
    if (!cfg.google_installation_id) throw new NotFoundError("google_not_connected");
    id = cfg.google_installation_id;
  } else if (by.installationId) {
    id = assertUuid(by.installationId);
  } else {
    throw new ValidationError("Provide fileKey or installationId");
  }

  const inst = await getInstallation(id);
  if (!inst) throw new NotFoundError("google_not_connected");
  // An installation is private to whoever signed in, unless it is already the
  // one on a file the caller may edit (the fileKey branch above).
  if (by.installationId && inst.figma_user_id !== callerId) {
    throw new ForbiddenError("google_installation_forbidden");
  }
  return inst;
}

/**
 * @param {string} id
 * @returns {Promise<GoogleInstallation | null>}
 */
export async function getInstallation(id) {
  const { data } = await supabase
    .from("google_installations")
    .select(INSTALLATION_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return data ?? null;
}

/**
 * A usable access token for the installation.
 *
 * @param {GoogleInstallation} inst
 * @returns {Promise<string>}
 */
export async function userAccessToken(inst) {
  if (inst.revoked_at) throw new UpstreamError("google_revoked");
  const cached = tokenCache.get(inst.id);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  /** @type {string} */
  let refreshToken;
  try {
    refreshToken = decrypt(inst.refresh_token_enc);
  } catch {
    logger.error("google_refresh_token_decrypt_failed", { installation_id: inst.id });
    throw new UpstreamError("google_token_unreadable");
  }

  try {
    const { accessToken, expiresIn } = await refreshGoogleAccessToken(refreshToken);
    tokenCache.set(inst.id, {
      token: accessToken,
      expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
    });
    return accessToken;
  } catch (err) {
    if (err instanceof UpstreamError && err.message === "google_revoked") {
      await markRevoked(inst.id);
    }
    throw err;
  }
}

/**
 * Google no longer honours this installation's refresh token: remember that,
 * and flag every config that depends on it so the plugin shows "reconnect".
 *
 * @param {string} installationId
 */
export async function markRevoked(installationId) {
  tokenCache.delete(installationId);
  const now = new Date().toISOString();
  await supabase
    .from("google_installations")
    .update({ revoked_at: now })
    .eq("id", installationId)
    .is("revoked_at", null);
  await supabase
    .from("configurations")
    .update({ delivery_status: "google_revoked", last_delivery_error: "invalid_grant" })
    .eq("google_installation_id", installationId)
    .in("delivery_status", ["ok", "send_failing"]);
  logger.warn("google_installation_revoked", { installation_id: installationId });
}

/** Test seam. */
export function _clearTokenCache() {
  tokenCache.clear();
}
