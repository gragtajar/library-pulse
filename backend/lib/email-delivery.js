// @ts-check
/**
 * Email delivery orchestration: confirmation emails when addresses are added,
 * and the publish notification fan-out. This is the I/O layer — the message
 * bodies, link tokens, recipient rules and the SES call each live in their
 * own (pure or single-purpose) module.
 *
 * Every send is recorded in `notification_log` with its `recipient`. That one
 * table gives us three things:
 *   - retry safety: a Figma retry skips recipients already marked `sent`
 *     (SES itself has no idempotency token);
 *   - the confirmation rate limit: at most 3 per address per day, so removing
 *     and re-adding an address can't be used to pester its owner;
 *   - the per-file daily cap on notifications, so a burst of publishes can't
 *     turn the sender into a spam source.
 */

import supabase from "./supabase.js";
import { logger } from "./logger.js";
import { buildConfirmEmail, buildPublishEmail } from "./email-message.js";
import { mintEmailToken } from "./email-tokens.js";
import { confirmedRecipients, maskEmail, normalizeRecipientList } from "./email-recipients.js";
import { EmailSendError, sendEmail } from "./email-send.js";
import { hasSentEmailDelivery } from "./idempotency.js";

export const CONFIRMATIONS_PER_ADDRESS_PER_DAY = 3;
export const PUBLISH_EMAILS_PER_CONFIG_PER_DAY = 150;
const SEND_CONCURRENCY = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

const CONFIRM_EVENT = "EMAIL_CONFIRM";
const PUBLISH_EVENT = "LIBRARY_PUBLISH";

/**
 * @typedef {Object} EmailConfig
 * @property {string} id
 * @property {string} figma_file_key
 * @property {string | null} [figma_file_name]
 * @property {unknown} [email_recipients]
 * @property {string | null} [email_timezone]
 * @property {string | null} [custom_message]
 */

/**
 * Send the double-opt-in confirmation to newly added addresses. Never throws:
 * a save must succeed even when mail is down; the summary tells the plugin
 * what happened.
 *
 * @param {EmailConfig} config
 * @param {string[]} emails
 * @returns {Promise<{ sent: number, failed: number, skipped: number }>}
 */
export async function sendConfirmations(config, emails) {
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const chunk of chunked(emails, SEND_CONCURRENCY)) {
    const results = await Promise.allSettled(
      chunk.map(async (email) => {
        if (
          (await countSentSince(CONFIRM_EVENT, { recipient: email })) >=
          CONFIRMATIONS_PER_ADDRESS_PER_DAY
        ) {
          logger.warn("email_confirm_rate_limited", { recipient: maskEmail(email) });
          return "skipped";
        }
        const token = mintEmailToken("confirm", config.id, email);
        const confirmUrl = `${publicUrl()}/api/email?action=confirm&token=${encodeURIComponent(token)}`;
        const mail = buildConfirmEmail({
          fileName: config.figma_file_name,
          recipient: email,
          confirmUrl,
        });
        await sendLogged({ to: email, ...mail }, config, CONFIRM_EVENT, null);
        return "sent";
      }),
    );
    for (const r of results) {
      if (r.status === "rejected") failed++;
      else if (r.value === "skipped") skipped++;
      else sent++;
    }
  }

  logger.info("email_confirmations_dispatched", { config_id: config.id, sent, failed, skipped });
  return { sent, failed, skipped };
}

/**
 * Send one publish notification to every confirmed recipient that hasn't
 * already received this event.
 *
 * @param {{ config: EmailConfig, payload: Record<string, any>, fileKey: string, eventKey: string }} args
 * @returns {Promise<{ sent: number, failed: number, skipped: number, total: number, errorCodes: string[] }>}
 */
export async function sendPublishEmails({ config, payload, fileKey, eventKey }) {
  const recipients = confirmedRecipients(normalizeRecipientList(config.email_recipients));
  const total = recipients.length;
  if (total === 0) {
    logger.info("webhook_email_no_confirmed_recipients", { config_id: config.id });
    return { sent: 0, failed: 0, skipped: 0, total, errorCodes: [] };
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  /** @type {string[]} */
  const errorCodes = [];

  // Skip recipients already delivered for this exact event (retry-safe).
  /** @type {string[]} */
  let pending = [];
  for (const email of recipients) {
    if (await hasSentEmailDelivery(eventKey, config.id, email)) skipped++;
    else pending.push(email);
  }

  // Per-file daily cap.
  if (pending.length > 0) {
    const used = await countSentSince(PUBLISH_EVENT, { configId: config.id });
    const room = Math.max(0, PUBLISH_EMAILS_PER_CONFIG_PER_DAY - used);
    if (room < pending.length) {
      logger.warn("email_daily_cap_reached", {
        config_id: config.id,
        used,
        dropped: pending.length - room,
      });
      skipped += pending.length - room;
      pending = pending.slice(0, room);
    }
  }

  for (const chunk of chunked(pending, SEND_CONCURRENCY)) {
    const results = await Promise.allSettled(
      chunk.map((email) => {
        const token = mintEmailToken("unsubscribe", config.id, email);
        const unsubscribeUrl = `${publicUrl()}/api/email?action=unsubscribe&token=${encodeURIComponent(token)}`;
        const mail = buildPublishEmail(payload, fileKey, {
          note: config.custom_message ?? null,
          timezone: config.email_timezone ?? null,
          recipient: email,
          unsubscribeUrl,
        });
        return sendLogged({ to: email, ...mail, unsubscribeUrl }, config, PUBLISH_EVENT, eventKey);
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") sent++;
      else {
        failed++;
        errorCodes.push(r.reason instanceof EmailSendError ? r.reason.code : "unknown");
      }
    }
  }

  return { sent, failed, skipped, total, errorCodes };
}

/**
 * Send one email and persist the outcome to `notification_log`. Re-throws the
 * send failure so callers can count it.
 *
 * @param {import("./email-send.js").OutgoingEmail} mail
 * @param {EmailConfig} config
 * @param {string} eventType
 * @param {string | null} eventKey
 */
async function sendLogged(mail, config, eventType, eventKey) {
  /** @type {EmailSendError | null} */
  let failure = null;
  try {
    await sendEmail(mail);
  } catch (err) {
    failure = err instanceof EmailSendError ? err : new EmailSendError("unknown", err);
  }

  const { error } = await supabase.from("notification_log").insert({
    configuration_id: config.id,
    figma_file_key: config.figma_file_key,
    event_type: eventType,
    event_key: eventKey,
    recipient: mail.to,
    status: failure ? "failed" : "sent",
    error_message: failure ? failure.code.slice(0, 200) : null,
  });
  if (error) logger.warn("email_log_insert_failed", { config_id: config.id, err: error });

  if (failure) {
    logger.warn("email_send_failed", {
      config_id: config.id,
      event_type: eventType,
      recipient: maskEmail(mail.to),
      code: failure.code,
    });
    throw failure;
  }
}

/**
 * How many emails of `eventType` were sent in the last 24 hours, for one
 * address or one config. A failed count is treated as "at the limit": when
 * we can't prove we're under it, we don't send.
 *
 * @param {string} eventType
 * @param {{ recipient?: string, configId?: string }} scope
 * @returns {Promise<number>}
 */
async function countSentSince(eventType, scope) {
  let query = supabase
    .from("notification_log")
    .select("id", { count: "exact", head: true })
    .eq("event_type", eventType)
    .eq("status", "sent")
    .not("recipient", "is", null)
    .gte("created_at", new Date(Date.now() - DAY_MS).toISOString());
  if (scope.recipient) query = query.eq("recipient", scope.recipient);
  if (scope.configId) query = query.eq("configuration_id", scope.configId);

  const { count, error } = await query;
  if (error || typeof count !== "number") {
    logger.warn("email_rate_count_failed", { event_type: eventType, err: error });
    return Number.MAX_SAFE_INTEGER;
  }
  return count;
}

function publicUrl() {
  const v = process.env.PUBLIC_URL;
  if (!v) throw new EmailSendError("not_configured");
  return v.replace(/\/+$/, "");
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {Generator<T[]>}
 */
function* chunked(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
