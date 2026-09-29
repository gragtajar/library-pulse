// @ts-check
/**
 * Amazon SES (API v2) send adapter — the only module that talks to the mail
 * service. One recipient per call, so every email carries its own
 * unsubscribe link and one bad address can't fail the others.
 *
 * Credentials come from OUR OWN variable names (SES_*) and are handed to the
 * client explicitly. Vercel's function runtime can pre-populate the standard
 * AWS_* variables with values that "do not grant any AWS permissions" (Vercel
 * docs, "Reserved environment variables"); letting the SDK's default chain
 * mix those with ours would produce invalid credentials.
 *
 * SES has no idempotency token, so de-duplication is the caller's job: the
 * webhook checks `notification_log` per recipient before it sends.
 */

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/** A failed send, carrying a short machine-readable code (the SES error name). */
export class EmailSendError extends Error {
  /**
   * @param {string} code
   * @param {unknown} [cause]
   */
  constructor(code, cause) {
    super(`email_send_error:${code}`);
    this.name = "EmailSendError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * @typedef {Object} OutgoingEmail
 * @property {string} to
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 * @property {string} [unsubscribeUrl]  adds the RFC 8058 one-click headers
 */

/** @type {SESv2Client | null} */
let cachedClient = null;

function getClient() {
  if (!cachedClient) {
    cachedClient = new SESv2Client({
      region: envOrThrow("SES_REGION"),
      credentials: {
        accessKeyId: envOrThrow("SES_ACCESS_KEY_ID"),
        secretAccessKey: envOrThrow("SES_SECRET_ACCESS_KEY"),
      },
      // One attempt, short timeouts: five recipients go out in two batches,
      // and even if SES hangs on every one the function must finish inside
      // Vercel's 15s maxDuration. A failed send is retried by the next Figma
      // delivery attempt (the webhook de-duplicates per recipient).
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 5000 },
    });
  }
  return cachedClient;
}

/**
 * Build the SES `SendEmail` input. Pure, so the exact request is testable.
 *
 * `from` is the verified sender, e.g. `Library Pulse <notifications@updates.example.com>`.
 * `feedbackAddress` (optional) receives replies and SES's bounce/complaint
 * forwards, so the From address itself doesn't need a mailbox.
 *
 * @param {OutgoingEmail} msg
 * @param {{ from: string, feedbackAddress?: string | null }} sender
 */
export function buildSendInput(msg, sender) {
  /** @type {Array<{ Name: string, Value: string }>} */
  const headers = [];
  if (msg.unsubscribeUrl) {
    headers.push(
      { Name: "List-Unsubscribe", Value: `<${msg.unsubscribeUrl}>` },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    );
  }
  return {
    FromEmailAddress: sender.from,
    Destination: { ToAddresses: [msg.to] },
    ...(sender.feedbackAddress
      ? {
          ReplyToAddresses: [sender.feedbackAddress],
          FeedbackForwardingEmailAddress: sender.feedbackAddress,
        }
      : {}),
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: msg.html, Charset: "UTF-8" },
          Text: { Data: msg.text, Charset: "UTF-8" },
        },
        ...(headers.length ? { Headers: headers } : {}),
      },
    },
  };
}

/**
 * Reduce any thrown value to a short code safe to store and show: the SES
 * error name (`MessageRejected`, `TooManyRequestsException`, …), `timeout`,
 * or `unknown`. Never the message — SES messages can echo addresses.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function sendErrorCode(err) {
  const name =
    err && typeof err === "object" && "name" in err ? String(/** @type {any} */ (err).name) : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (/^[A-Za-z]{3,60}$/.test(name) && name !== "Error") return name;
  return "unknown";
}

/**
 * Send one email. Throws `EmailSendError` on any failure.
 *
 * @param {OutgoingEmail} msg
 * @param {{ client?: { send: (command: any) => Promise<any> } }} [deps]  test seam
 * @returns {Promise<{ messageId: string | null }>}
 */
export async function sendEmail(msg, deps = {}) {
  const input = buildSendInput(msg, {
    from: envOrThrow("EMAIL_FROM"),
    feedbackAddress: process.env.EMAIL_FEEDBACK_ADDRESS || null,
  });
  try {
    const client = deps.client ?? getClient();
    const out = await client.send(new SendEmailCommand(input));
    return { messageId: typeof out?.MessageId === "string" ? out.MessageId : null };
  } catch (err) {
    if (err instanceof EmailSendError) throw err;
    throw new EmailSendError(sendErrorCode(err), err);
  }
}

/** @param {string} name */
function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new EmailSendError("not_configured");
  return v;
}
