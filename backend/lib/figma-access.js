// @ts-check
/**
 * File-access verification for the org-shared, per-file config model.
 *
 * A file's notification config is shared by everyone with access to that file
 * (Batch 2, SPEC §0/§3). So before returning or mutating a file's config on a
 * caller's behalf, we confirm the caller can actually access that file — using
 * *their own* Figma OAuth token, by listing the webhooks registered on the file
 * (`GET /v2/webhooks?context=file&context_id=…`), which requires `webhooks:read`.
 *
 * Rollout note: tokens minted before Batch 2 only carry `webhooks:write`, so
 * `assertFileAccess` asks those users to reconnect Figma (rather than mislabel
 * them as "no access"). New authorizations request both scopes — see
 * `figma-oauth.js`.
 *
 * ⚠️ BUILD-TIME VERIFICATION (do NOT assume — SPEC §4a / build-time item #1):
 * confirm this GET returns **403** — not an empty **200** — for a file the
 * caller cannot access. If Figma returns 200-with-empty-list regardless of
 * access, this probe does not gate access and we must switch to
 * `file_metadata:read`. Until verified live, treat this as unproven.
 */

import supabase from "./supabase.js";
import { decrypt } from "./encryption.js";
import { fetchWithTimeout } from "./http.js";
import { logger } from "./logger.js";
import { ForbiddenError, UpstreamError, ValidationError } from "./errors.js";
import { classifyAccess, scopeGranted } from "./figma-oauth.js";

/**
 * Decrypt the caller's Figma access token along with the scopes it was granted.
 * Throws if they haven't connected Figma or the token has expired.
 *
 * @param {string} figmaUserId
 * @returns {Promise<{ token: string, scopes: string|null }>}
 */
export async function getFigmaAccessToken(figmaUserId) {
  const { data: tok } = await supabase
    .from("figma_tokens")
    .select("access_token_enc, expires_at, scopes")
    .eq("figma_user_id", figmaUserId)
    .maybeSingle();

  if (!tok || !tok.access_token_enc) throw new ValidationError("figma_not_connected");
  if (tok.expires_at && new Date(tok.expires_at).getTime() < Date.now()) {
    throw new ValidationError("figma_reauth_required");
  }
  return { token: decrypt(tok.access_token_enc), scopes: tok.scopes ?? null };
}

/**
 * Confirm the caller can access `fileKey`. Resolves on success; throws
 * `ValidationError("figma_reauth_required")` if they must reconnect Figma,
 * `ForbiddenError` if they lack access, or `UpstreamError` on a transient fault.
 *
 * @param {string} figmaUserId
 * @param {string} fileKey
 * @returns {Promise<void>}
 */
export async function assertFileAccess(figmaUserId, fileKey) {
  const { token, scopes } = await getFigmaAccessToken(figmaUserId);
  const hasReadScope = scopeGranted(scopes, "webhooks:read");

  // Don't waste a doomed API call for a token we know lacks the read scope.
  if (!hasReadScope) throw new ValidationError("figma_reauth_required");

  const url = `https://api.figma.com/v2/webhooks?context=file&context_id=${encodeURIComponent(fileKey)}`;
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 10_000,
  });

  const outcome = classifyAccess({ hasReadScope, ok: res.ok, status: res.status });
  if (outcome === "ok") return;
  if (outcome === "reauth") throw new ValidationError("figma_reauth_required");
  if (outcome === "forbidden") {
    logger.warn("figma_file_access_denied", { file_key: fileKey });
    throw new ForbiddenError("figma_file_access_denied");
  }

  const body = await res.text().catch(() => "");
  logger.warn("figma_webhooks_list_failed", { status: res.status, body: body.slice(0, 200) });
  throw new UpstreamError(`figma_webhooks_list_${res.status}`);
}
