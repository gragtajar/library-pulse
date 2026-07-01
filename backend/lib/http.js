// @ts-check
/**
 * HTTP plumbing: CORS for Figma plugin iframe + `fetchWithTimeout` so
 * Slack/Figma upstream hangs can't push us past Vercel's `maxDuration`.
 *
 * Per v2 §T6.4 — Node 18+ `AbortSignal.timeout` is sufficient; no custom
 * controller plumbing needed.
 */

import { errorToResponse, LibraryPulseError } from "./errors.js";
import { logger } from "./logger.js";

/**
 * Figma plugin UIs are rendered inside an iframe with `srcdoc`, which gives
 * them `Origin: null`. Allow that, plus any explicit dev origin set via env.
 *
 * Webhook + OAuth callback endpoints don't need CORS at all (Figma/Slack call
 * them server-side); callers should use `applyCors(req, res, { strict: true })`
 * to deny browser cross-origin requests for those endpoints.
 *
 * @param {import("./types.js").VercelRequest} req
 * @param {import("./types.js").VercelResponse} res
 * @param {{ strict?: boolean }} [opts]
 * @returns {boolean} `true` if request was an OPTIONS preflight (caller should return)
 */
export function applyCors(req, res, opts = {}) {
  const origin = /** @type {string|undefined} */ (req.headers?.origin);
  const allowed = new Set([
    "null", // Figma plugin srcdoc iframe
    ...(process.env.ALLOWED_ORIGINS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []),
  ]);

  if (opts.strict) {
    // No CORS at all for server-to-server endpoints.
    res.setHeader("Vary", "Origin");
  } else if (!origin || allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "null");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Figma-User");
    res.setHeader("Access-Control-Max-Age", "600");
  } else {
    // Origin present but not in the allow list — refuse to set the header
    // so the browser blocks the response.
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

/**
 * Wrap a handler so any thrown `LibraryPulseError` becomes a typed JSON
 * response. Unknown throws are logged and return a generic 500.
 *
 * @template {Function} H
 * @param {H} handler
 * @returns {H}
 */
export function withErrorHandling(handler) {
  // @ts-expect-error generic wrapper
  return async function wrapped(req, res) {
    try {
      return await handler(req, res);
    } catch (err) {
      if (!(err instanceof LibraryPulseError)) {
        logger.error("unhandled_exception", {
          path: req.url,
          method: req.method,
          err,
        });
      }
      const { status, body } = errorToResponse(err);
      res.status(status).json(body);
      return undefined;
    }
  };
}

/**
 * `fetch` with a hard timeout. Returns the `Response` or throws.
 *
 * @param {string | URL} url
 * @param {RequestInit & { timeoutMs?: number }} [init]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init = {}) {
  const { timeoutMs = 8000, ...rest } = init;
  return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}
