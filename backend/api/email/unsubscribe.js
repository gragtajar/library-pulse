// @ts-check
/**
 * /api/email/unsubscribe?token=… — the unsubscribe link in every notification.
 *
 *   GET   → a page with an "Unsubscribe" button. Never unsubscribes by
 *           itself: mail gateways and link scanners follow GET links.
 *   POST  → unsubscribes (idempotent). Two callers:
 *             - the button on that page → an HTML result page;
 *             - a mail client's one-click unsubscribe (RFC 8058: the
 *               `List-Unsubscribe-Post` header makes it POST the body
 *               `List-Unsubscribe=One-Click`) → a bare 200.
 *
 * No session: the signed token in the link is the credential. Unsubscribing
 * takes effect immediately — the next publish already skips the address.
 * The response never reveals whether the address was on the list.
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

    const oneClick = req.method === "POST" && isOneClick(req.body);
    const token = single(req.query.token);

    /** @type {{ configId: string, email: string }} */
    let claim;
    try {
      claim = verifyEmailToken(token, "unsubscribe");
    } catch {
      if (oneClick) return res.status(400).send("Invalid unsubscribe link");
      return renderEmailPage(res, {
        tone: "error",
        status: 400,
        heading: "This link isn't valid",
        message:
          "Open the unsubscribe link from a recent Library Pulse email, or ask an editor of the Figma file to remove your address.",
      });
    }

    if (req.method === "GET") {
      return renderEmailPage(res, {
        tone: "neutral",
        heading: "Unsubscribe from these updates?",
        message: `${claim.email} will stop getting emails when this Figma library is published.`,
        form: {
          action: `/api/email/unsubscribe?token=${encodeURIComponent(String(token))}`,
          buttonLabel: "Unsubscribe",
          buttonTone: "danger",
        },
      });
    }

    const { data: config, error } = await supabase
      .from("configurations")
      .select("id, email_recipients")
      .eq("id", claim.configId)
      .maybeSingle();
    if (error) {
      logger.error("email_unsubscribe_lookup_failed", { err: error });
      if (oneClick) return res.status(502).send("Temporary error");
      return renderEmailPage(res, {
        tone: "error",
        status: 502,
        heading: "Something went wrong",
        message: "We couldn't process that. Please try the link again in a minute.",
      });
    }

    // Address already gone (or never there) → nothing to do, same answer.
    const next = config
      ? setRecipientStatus(
          normalizeRecipientList(config.email_recipients),
          claim.email,
          "unsubscribed",
        )
      : null;
    if (config && next) {
      const { error: upErr } = await supabase
        .from("configurations")
        .update({ email_recipients: next })
        .eq("id", config.id);
      if (upErr) {
        logger.error("email_unsubscribe_update_failed", { err: upErr });
        if (oneClick) return res.status(502).send("Temporary error");
        return renderEmailPage(res, {
          tone: "error",
          status: 502,
          heading: "Something went wrong",
          message: "We couldn't process that. Please try the link again in a minute.",
        });
      }
      logger.info("email_recipient_unsubscribed", {
        config_id: config.id,
        recipient: maskEmail(claim.email),
        one_click: oneClick,
      });
    }

    if (oneClick) return res.status(200).send("Unsubscribed");
    return renderEmailPage(res, {
      tone: "success",
      heading: "You're unsubscribed",
      message: "You won't get any more emails about this Figma library.",
    });
  },
);

/**
 * RFC 8058 one-click: the mail client POSTs `List-Unsubscribe=One-Click`
 * (form-encoded). Vercel parses that into an object; tolerate a raw string.
 *
 * @param {unknown} body
 * @returns {boolean}
 */
function isOneClick(body) {
  if (typeof body === "string") return body.includes("List-Unsubscribe=One-Click");
  if (body && typeof body === "object") {
    return /** @type {Record<string, unknown>} */ (body)["List-Unsubscribe"] === "One-Click";
  }
  return false;
}

/**
 * @param {string | string[] | undefined} v
 * @returns {string | undefined}
 */
function single(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}
