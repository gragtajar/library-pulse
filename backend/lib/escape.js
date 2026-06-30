// @ts-check
/**
 * Escape helpers — sanitize untrusted input before injecting into HTML or
 * Slack `mrkdwn`/`plain_text` blocks.
 *
 * Why: OAuth callback pages reflect query-param error strings, and Slack
 * blocks reflect user-controlled file names and descriptions. Without
 * escaping, both can render unintended markup.
 */

const HTML_ENTITIES = /** @type {const} */ ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "/": "&#x2F;",
  "`": "&#x60;",
});

/**
 * HTML-escape a string for safe insertion into element text or attributes.
 * Always returns a string even for null/undefined input.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function escapeHtml(input) {
  if (input == null) return "";
  const s = String(input);
  return s.replace(/[&<>"'`/]/g, (ch) => HTML_ENTITIES[/** @type {keyof typeof HTML_ENTITIES} */ (ch)]);
}

/**
 * Escape user-controlled text destined for a Slack `mrkdwn` block.
 * Slack only treats `&`, `<`, and `>` as special inside `mrkdwn`.
 * See: https://api.slack.com/reference/surfaces/formatting#escaping
 *
 * @param {unknown} input
 * @returns {string}
 */
export function escapeSlack(input) {
  if (input == null) return "";
  return String(input).replace(/[&<>]/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    return "&gt;";
  });
}
