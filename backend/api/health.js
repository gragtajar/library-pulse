// @ts-check
/**
 * GET /api/health — lightweight liveness probe for uptime monitors.
 * Returns the deployment commit (when Vercel injects it) so on-call can
 * confirm which build a failing endpoint is on.
 */

import { applyCors, withErrorHandling } from "../lib/http.js";

export default withErrorHandling(
  /**
   * @param {import("../lib/types.js").VercelRequest} req
   * @param {import("../lib/types.js").VercelResponse} res
   */
  function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      status: "ok",
      service: "library-pulse",
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
      timestamp: new Date().toISOString(),
    });
  },
);
