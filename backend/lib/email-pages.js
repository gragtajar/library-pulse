// @ts-check
/**
 * The small HTML pages behind the links in our emails: confirmation result,
 * the unsubscribe prompt (GET) and its result (POST).
 *
 * Same discipline as lib/oauth-result-page.js: every string that could carry
 * user data (file names) is HTML-escaped, and a strict CSP means no scripts
 * at all. The one difference is `form-action 'self'`: the unsubscribe page
 * needs a real button (a POST) so that link-scanning mail gateways, which
 * follow GET links, can't unsubscribe people by accident.
 */

import { escapeHtml } from "./escape.js";

/**
 * @param {import("./types.js").VercelResponse} res
 * @param {{
 *   tone: "success" | "error" | "neutral",
 *   heading: string,
 *   message: string,
 *   form?: { action: string, buttonLabel: string, buttonTone?: "primary" | "danger" },
 *   status?: number,
 * }} opts
 * @returns {import("./types.js").VercelResponse}
 */
export function renderEmailPage(res, { tone, heading, message, form, status = 200 }) {
  const color = tone === "success" ? "#116329" : tone === "error" ? "#cf222e" : "#1f2328";
  const danger = form?.buttonTone === "danger";
  // Both pass 4.5:1 under white 13px text.
  const buttonBg = danger ? "#cf222e" : "#0969da";
  const buttonHover = danger ? "#a40e26" : "#0757b5";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");

  const button = form
    ? `<form method="post" action="${escapeHtml(form.action)}"><button type="submit">${escapeHtml(form.buttonLabel)}</button></form>`
    : "";

  return res.status(status).send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Library Pulse</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; background: #f6f8fa; color: #1f2328; }
  .card { background: #fff; padding: 40px; border-radius: 12px; border: 1px solid #d0d7de;
          text-align: center; max-width: 440px; margin: 16px; }
  h1 { color: ${color}; font-size: 20px; margin: 0 0 12px; }
  p { color: #57606a; line-height: 1.5; margin: 0; }
  form { margin-top: 20px; }
  button { font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: ${buttonBg}; color: #fff; border: 0; border-radius: 6px; padding: 10px 18px; cursor: pointer; }
  button:hover { background: ${buttonHover}; }
  .hint { margin-top: 24px; color: #57606a; font-size: 12px; }
  button:focus-visible { outline: 2px solid #0969da; outline-offset: 2px; }
</style></head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
    ${button}
    <p class="hint">Library Pulse, a Figma plugin. You can close this tab.</p>
  </div>
</body></html>`);
}
