// @ts-check
/**
 * /api/email?action=confirm|unsubscribe&token=… — the links in our emails.
 *
 *   action=confirm      the double-opt-in link in a confirmation email
 *   action=unsubscribe  the unsubscribe link (and one-click target) in every
 *                       notification
 *
 * One function for both: every file under `api/` is its own Vercel Function,
 * and the Hobby plan caps them per deployment (lib/dispatch.js, which the
 * other grouped functions use, came later). The actions themselves are in
 * lib/email-links.js.
 */

import { applyCors, withErrorHandling } from "../lib/http.js";
import { renderEmailPage } from "../lib/email-pages.js";
import { confirmAddress, unsubscribeAddress } from "../lib/email-links.js";

export default withErrorHandling(
  /**
   * @param {import("../lib/types.js").VercelRequest} req
   * @param {import("../lib/types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (applyCors(req, res, { strict: true })) return;
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const raw = req.query.action;
    const action = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
    if (action === "confirm") return confirmAddress(req, res);
    if (action === "unsubscribe") return unsubscribeAddress(req, res);

    return renderEmailPage(res, {
      tone: "error",
      status: 400,
      heading: "This link isn't valid",
      message: "Open the link from your Library Pulse email again.",
    });
  },
);
