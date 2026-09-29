// @ts-check
/**
 * /api/email/confirm?token=… — the double-opt-in link in a confirmation email.
 *
 *   GET   → a page with a "Confirm address" button. Never confirms by itself:
 *           mail gateways and link scanners follow GET links, and consent has
 *           to come from the person, not from their spam filter.
 *   POST  → marks the address confirmed (idempotent) and says so.
 *
 * No session: the signed token in the link is the credential (it names the
 * config and the address, and expires after 7 days). This endpoint is opened
 * in a real browser, so every response is an escaped HTML page under a strict
 * CSP (lib/email-pages.js).
 */

import supabase from "../../lib/supabase.js";
import { logger } from "../../lib/logger.js";
import { applyCors, withErrorHandling } from "../../lib/http.js";
import { verifyEmailToken } from "../../lib/email-tokens.js";
import { renderEmailPage } from "../../lib/email-pages.js";
import {
  maskEmail,
  normalizeRecipientList,
  setRecipientStatus,
} from "../../lib/email-recipients.js";

export default withErrorHandling(
  /**
   * @param {import("../../lib/types.js").VercelRequest} req
   * @param {import("../../lib/types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (applyCors(req, res, { strict: true })) return;
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const token = single(req.query.token);
    /** @type {{ configId: string, email: string }} */
    let claim;
    try {
      claim = verifyEmailToken(token, "confirm");
    } catch (err) {
      const expired = err instanceof Error && err.message === "email_link_expired";
      return renderEmailPage(res, {
        tone: "error",
        status: 400,
        heading: expired ? "This link has expired" : "This link isn't valid",
        message: expired
          ? "Confirmation links last 7 days. Ask an editor of the Figma file to remove your address and add it again to get a new one."
          : "Open the link from your confirmation email again, or ask an editor of the Figma file to re-add your address.",
      });
    }

    const { data: config, error } = await supabase
      .from("configurations")
      .select("id, figma_file_name, destination, email_recipients")
      .eq("id", claim.configId)
      .maybeSingle();
    if (error) {
      logger.error("email_confirm_lookup_failed", { err: error });
      return renderEmailPage(res, {
        tone: "error",
        status: 502,
        heading: "Something went wrong",
        message: "We couldn't load this notification list. Please try the link again in a minute.",
      });
    }

    const list = normalizeRecipientList(config?.email_recipients);
    const entry = list.find((r) => r.email === claim.email);
    const fileName = config?.figma_file_name || "this Figma library";

    if (!config || config.destination !== "email" || !entry) {
      return renderEmailPage(res, {
        tone: "neutral",
        heading: "This address is no longer on the list",
        message:
          "An editor removed it, or the file's notifications were changed. Nothing will be sent to you.",
      });
    }
    if (entry.status === "unsubscribed") {
      return renderEmailPage(res, {
        tone: "neutral",
        heading: "You unsubscribed from these updates",
        message: `To get emails about ${fileName} again, ask an editor of the file to remove your address and add it back.`,
      });
    }
    if (entry.status === "confirmed") {
      return renderEmailPage(res, {
        tone: "success",
        heading: "You're already confirmed",
        message: `You'll get an email each time ${fileName} is published.`,
      });
    }

    if (req.method === "GET") {
      return renderEmailPage(res, {
        tone: "neutral",
        heading: "Confirm your address",
        message: `Get an email at ${claim.email} each time ${fileName} is published in Figma.`,
        form: {
          action: `/api/email/confirm?token=${encodeURIComponent(String(token))}`,
          buttonLabel: "Confirm address",
        },
      });
    }

    const next = setRecipientStatus(list, claim.email, "confirmed");
    const { error: upErr } = await supabase
      .from("configurations")
      .update({ email_recipients: next })
      .eq("id", config.id);
    if (upErr) {
      logger.error("email_confirm_update_failed", { err: upErr });
      return renderEmailPage(res, {
        tone: "error",
        status: 502,
        heading: "Something went wrong",
        message: "We couldn't save your confirmation. Please try the link again in a minute.",
      });
    }

    logger.info("email_recipient_confirmed", {
      config_id: config.id,
      recipient: maskEmail(claim.email),
    });
    return renderEmailPage(res, {
      tone: "success",
      heading: "You're confirmed",
      message: `You'll get an email each time ${fileName} is published. Every email has an unsubscribe link.`,
    });
  },
);

/**
 * @param {string | string[] | undefined} v
 * @returns {string | undefined}
 */
function single(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}
