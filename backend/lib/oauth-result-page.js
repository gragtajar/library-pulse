// @ts-check
/**
 * Renders the small HTML page shown after an OAuth callback returns.
 *
 * Why this is its own module:
 *   1. It runs after Slack/Figma redirect a real browser to us — so the
 *      page must escape any user-controlled `message` text. v1's inline
 *      template literal interpolated `${message}` directly, which is XSS
 *      if `message` came from an upstream `?error=…` param.
 *   2. It must set a CSP so a compromised string can't load remote scripts.
 *   3. Centralising it means both callbacks (Slack + Figma) stay in sync.
 */

import { escapeHtml } from "./escape.js";

/**
 * Write an OAuth result page to `res`. Returns the response untouched so
 * callers can `return renderResultPage(...)`.
 *
 * @param {import("./types.js").VercelResponse} res
 * @param {{ success: boolean, message: string }} opts
 * @returns {import("./types.js").VercelResponse}
 */
export function renderResultPage(res, { success, message }) {
  const color = success ? "#2da44e" : "#cf222e";
  const icon = success ? "✅" : "❌";
  const heading = success ? "Connected" : "Connection failed";
  const safeMessage = escapeHtml(message);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Hardened CSP — only inline styles allowed (we ship none from user input).
  // No script-src means no JS at all.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");

  return res.status(200).send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Library Pulse</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; background: #f6f8fa; color: #24292f; }
  .card { background: #fff; padding: 48px; border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,.12); text-align: center; max-width: 420px; }
  h2 { color: ${color}; margin: 0 0 12px; }
  p { color: #57606a; line-height: 1.5; }
  .hint { margin-top: 24px; color: #8b949e; font-size: 13px; }
</style></head>
<body>
  <div class="card">
    <h2>${icon} ${escapeHtml(heading)}</h2>
    <p>${safeMessage}</p>
    <p class="hint">You can close this tab and return to Figma.</p>
  </div>
</body></html>`);
}
