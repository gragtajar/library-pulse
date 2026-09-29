// @ts-check
/**
 * Pure helpers for the email destination's recipient list — the
 * `configurations.email_recipients` JSONB column (migration 006):
 *
 *   [{ email, status: "pending" | "confirmed" | "unsubscribed",
 *      added_at, confirmed_at }]
 *
 * Double opt-in: an address is added as "pending", becomes "confirmed" only
 * when its owner clicks the confirmation link, and only confirmed addresses
 * are ever sent a notification. "unsubscribed" is set by the unsubscribe
 * link and is sticky — an editor re-saving the same list can't undo it; the
 * address has to be removed and added again, which sends a fresh
 * confirmation the owner can ignore. Everything here is I/O-free so it's
 * unit-testable; the handlers do the reads and writes.
 */

/** @typedef {"pending" | "confirmed" | "unsubscribed"} RecipientStatus */
/** @typedef {{ email: string, status: RecipientStatus, added_at: string, confirmed_at: string | null }} Recipient */

const STATUSES = new Set(["pending", "confirmed", "unsubscribed"]);

/**
 * Defensive read of the stored list: drops anything that isn't a well-formed
 * entry, so a hand-edited row can't crash delivery.
 *
 * @param {unknown} raw
 * @returns {Recipient[]}
 */
export function normalizeRecipientList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Recipient[]} */
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = /** @type {Record<string, unknown>} */ (entry);
    if (typeof e.email !== "string" || !e.email) continue;
    const status = typeof e.status === "string" && STATUSES.has(e.status) ? e.status : "pending";
    out.push({
      email: e.email,
      status: /** @type {RecipientStatus} */ (status),
      added_at: typeof e.added_at === "string" ? e.added_at : "",
      confirmed_at: typeof e.confirmed_at === "string" ? e.confirmed_at : null,
    });
  }
  return out;
}

/**
 * Reconcile the stored list with the addresses an editor just saved.
 * Retained addresses keep their entry (and status) untouched; new ones start
 * as pending and are returned in `added` so the caller can send their
 * confirmation; addresses no longer in the request are dropped.
 *
 * @param {Recipient[]} existing
 * @param {string[]} requested  normalized, de-duplicated addresses
 * @param {string} [now]  ISO timestamp for `added_at`
 * @returns {{ recipients: Recipient[], added: string[] }}
 */
export function mergeRecipients(existing, requested, now = new Date().toISOString()) {
  const byEmail = new Map(existing.map((r) => [r.email, r]));
  /** @type {Recipient[]} */
  const recipients = [];
  /** @type {string[]} */
  const added = [];
  for (const email of requested) {
    const kept = byEmail.get(email);
    if (kept) {
      recipients.push(kept);
    } else {
      recipients.push({ email, status: "pending", added_at: now, confirmed_at: null });
      added.push(email);
    }
  }
  return { recipients, added };
}

/**
 * An address safe to put in a log line: first character of the local part,
 * then the domain ("a***@example.com"). Full addresses stay out of logs.
 *
 * @param {string} email
 * @returns {string}
 */
export function maskEmail(email) {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Addresses that may actually be emailed.
 *
 * @param {Recipient[]} list
 * @returns {string[]}
 */
export function confirmedRecipients(list) {
  return list.filter((r) => r.status === "confirmed").map((r) => r.email);
}

/**
 * Return a copy of the list with one address moved to `status`, or `null`
 * when the address isn't in the list (it was removed after the email went
 * out). `confirmed_at` is stamped on confirmation and cleared otherwise.
 *
 * @param {Recipient[]} list
 * @param {string} email
 * @param {RecipientStatus} status
 * @param {string} [now]
 * @returns {Recipient[] | null}
 */
export function setRecipientStatus(list, email, status, now = new Date().toISOString()) {
  if (!list.some((r) => r.email === email)) return null;
  return list.map((r) =>
    r.email === email
      ? { ...r, status, confirmed_at: status === "confirmed" ? (r.confirmed_at ?? now) : null }
      : r,
  );
}
