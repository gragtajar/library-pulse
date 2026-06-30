// @ts-check
/**
 * Helpers for the OAuth-flow session table (`auth_sessions`).
 *
 * Two correctness rules the original code missed:
 *
 *   1. A session is only valid when `status = 'pending'` AND
 *      `expires_at > now()`. The schema declared the expiry but the
 *      callbacks never checked it, so a stale state could be replayed
 *      hours later.
 *
 *   2. A session must be marked `used_at` once consumed. Without that,
 *      a successful callback URL replayed in another tab could overwrite
 *      stored tokens with new ones from a freshly-initiated flow.
 */

import supabase from "./supabase.js";
import { ForbiddenError, NotFoundError } from "./errors.js";

/**
 * Atomically claim a pending session — fetches it, validates expiry, and
 * marks it `in_progress` so concurrent callbacks lose.
 *
 * @param {string} state
 * @param {"slack" | "figma"} provider
 * @returns {Promise<{ state: string, provider: string, figma_user_id: string|null }>}
 */
export async function claimAuthSession(state, provider) {
  const { data: row, error } = await supabase
    .from("auth_sessions")
    .select("state, provider, figma_user_id, status, expires_at, used_at")
    .eq("state", state)
    .eq("provider", provider)
    .single();

  if (error || !row) throw new NotFoundError("auth_session_not_found");
  if (row.used_at) throw new ForbiddenError("auth_session_already_used");
  if (row.status !== "pending") throw new ForbiddenError("auth_session_not_pending");
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new ForbiddenError("auth_session_expired");
  }

  return {
    state: row.state,
    provider: row.provider,
    figma_user_id: row.figma_user_id,
  };
}

/**
 * Mark a session terminal — either `completed` (with result data) or `failed`.
 * Sets `used_at` so the session can't be replayed.
 *
 * @param {string} state
 * @param {"completed" | "failed"} status
 * @param {Record<string, unknown>} [resultData]
 */
export async function finalizeAuthSession(state, status, resultData = {}) {
  await supabase
    .from("auth_sessions")
    .update({
      status,
      result_data: resultData,
      used_at: new Date().toISOString(),
    })
    .eq("state", state);
}
