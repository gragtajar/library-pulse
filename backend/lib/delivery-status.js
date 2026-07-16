// @ts-check
/**
 * Pure decision for a config's `delivery_status` after a Slack fan-out (§6a),
 * kept I/O-free so it's unit-testable.
 */

/** Slack errors that mean the bot token is no longer usable. */
export const SLACK_AUTH_ERRORS = new Set(["token_revoked", "invalid_auth", "account_inactive"]);

/**
 * @param {string[]} errorCodes  Slack error codes from failed channel posts
 * @param {number} failed        count of failed channel posts
 * @returns {{ status: "ok"|"slack_revoked"|"send_failing", lastError: string|null }}
 */
export function deliveryStatusFor(errorCodes, failed) {
  const authErr = errorCodes.find((c) => SLACK_AUTH_ERRORS.has(c));
  if (authErr) return { status: "slack_revoked", lastError: authErr };
  if (failed > 0) return { status: "send_failing", lastError: errorCodes[0] ?? "send_failed" };
  return { status: "ok", lastError: null };
}
