// @ts-check
/**
 * The two actions behind the links in our emails. `api/email.js` routes to
 * them by `?action=`; they live here (not as separate files under `api/`)
 * because every file under `api/` is its own Vercel Function and the Hobby
 * plan allows 12 per deployment.
 *
 * Shared rules:
 *   - No session. The signed token in the link is the credential: it names
 *     one config and one address (lib/email-tokens.js).
 *   - GET only renders a page with a button; POST acts. Mail gateways and
 *     link scanners follow GET links, and neither consent nor an unsubscribe
 *     should come from a spam filter.
 *   - These are opened in a real browser, so every response is an escaped
 *     HTML page under a strict CSP (lib/email-pages.js).
 */

import supabase from "./supabase.js";
import { logger } from "./logger.js";
import { verifyEmailToken } from "./email-tokens.js";
import { renderEmailPage } from "./email-pages.js";
import { maskEmail, normalizeRecipientList, setRecipientStatus } from "./email-recipients.js";

/**
 * Double opt-in: the link in a confirmation email. POST marks the address
 * confirmed (idempotent). Confirm links expire after 7 days.
 *
 * @param {import("./types.js").VercelRequest} req
 * @param {import("./types.js").VercelResponse} res
 */
export async function confirmAddress(req, res) {
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
        action: `/api/email?action=confirm&token=${encodeURIComponent(String(token))}`,
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
}

/**
 * The unsubscribe link in every notification. POST unsubscribes (idempotent)
 * for two callers: the button on the page (answers with an HTML result) and a
 * mail client's one-click unsubscribe (RFC 8058: the `List-Unsubscribe-Post`
 * header makes it POST the body `List-Unsubscribe=One-Click`; answers with a
 * bare 200). Takes effect immediately — the next publish already skips the
 * address — and never reveals whether the address was on the list.
 *
 * @param {import("./types.js").VercelRequest} req
 * @param {import("./types.js").VercelResponse} res
 */
export async function unsubscribeAddress(req, res) {
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
        action: `/api/email?action=unsubscribe&token=${encodeURIComponent(String(token))}`,
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
}

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
