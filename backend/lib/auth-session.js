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
import { ForbiddenError } from "./errors.js";

/**
 * Atomically claim a pending session. This is a single conditional UPDATE that
 * stamps `used_at` only if the row is still `pending`, unused, and unexpired —
 * so two concurrent callbacks racing the same `state` can never both win
 * (exactly one UPDATE matches `used_at IS NULL`). The previous implementation
 * was a plain SELECT, which left a TOCTOU window despite claiming atomicity.
 *
 * @param {string} state
 * @param {"slack" | "figma"} provider
 * @returns {Promise<{ state: string, provider: string, figma_user_id: string|null }>}
 */
export async function claimAuthSession(state, provider) {
  const nowIso = new Date().toISOString();
  const { data: row, error } = await supabase
    .from("auth_sessions")
    .update({ used_at: nowIso })
    .eq("state", state)
    .eq("provider", provider)
    .eq("status", "pending")
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("state, provider, figma_user_id")
    .single();

  // No row matched the conditional update: it doesn't exist, was already
  // claimed, isn't pending, or has expired. We can't cheaply distinguish, so
  // surface a single 403 — the callback can't proceed regardless.
  if (error || !row) throw new ForbiddenError("auth_session_invalid_or_used");

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
