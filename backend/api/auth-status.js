// @ts-check
/**
 * GET /api/auth-status?state=…
 *
 * Polled by the Figma plugin UI to check whether an OAuth flow completed.
 * Returns `{ status, provider, data? }`.
 *
 * Hardening over v1:
 *   - state is UUID-validated before hitting the DB
 *   - expired sessions return `expired` (not `pending` forever)
 *   - we only return `result_data` for `completed` sessions
 */

import supabase from "../lib/supabase.js";
import { applyCors, withErrorHandling } from "../lib/http.js";
import { assertUuid } from "../lib/validators.js";

export default withErrorHandling(
  /**
   * @param {import("../lib/types.js").VercelRequest} req
   * @param {import("../lib/types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (applyCors(req, res)) return;
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const stateRaw = req.query.state;
    const state =
      typeof stateRaw === "string" ? stateRaw : Array.isArray(stateRaw) ? stateRaw[0] : "";
    assertUuid(state);

    const { data: session, error } = await supabase
      .from("auth_sessions")
      .select("status, result_data, provider, expires_at")
      .eq("state", state)
      .single();

    if (error || !session) return res.status(404).json({ status: "not_found" });

    let status = session.status;
    if (
      status === "pending" &&
      session.expires_at &&
      new Date(session.expires_at).getTime() < Date.now()
    ) {
      status = "expired";
    }

    return res.status(200).json({
      status,
      provider: session.provider,
      data: status === "completed" ? session.result_data : undefined,
    });
  },
);
