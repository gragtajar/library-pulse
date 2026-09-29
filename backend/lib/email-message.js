// @ts-check
/**
 * Build the notification and confirmation emails for the email destination.
 *
 * The notification carries everything the Slack message does (publisher,
 * time, description, team note, added/modified/removed items per category,
 * "Open in Figma") from the same `LIBRARY_PUBLISH` payload, rendered as a
 * mail-client-safe HTML table with a plain-text twin. Every user-controlled
 * value (file name, publisher handle, item names, description, note) goes
 * through `esc` before it reaches the HTML, and the note is plain text here —
 * Slack mention tokens are a Slack-only concept.
 *
 * Time: Slack renders our timestamp in each reader's own zone; email can't,
 * so the publish time is shown in the timezone the editor saved with the
 * list (the plugin captures it from their browser) and labelled as such.
 */

const MAX_ITEMS_DISPLAY = 20; // parity with slack-blocks.js
const MAX_DESCRIPTION_CHARS = 1500;
const MAX_SUBJECT_CHARS = 150;

// Light Primer-derived palette — the same semantics the plugin's --lp-* tokens
// carry (success / warning / danger / secondary text), in mail-safe hex.
const C = {
  text: "#1f2328",
  muted: "#57606a",
  border: "#d0d7de",
  page: "#f6f8fa",
  card: "#ffffff",
  // The action colour. Primer's accent blue rather than Figma's #0d99ff:
  // white 13px text needs 4.5:1, and #0d99ff only reaches 3:1.
  brand: "#0969da",
  success: "#116329",
  amber: "#9a6700",
  danger: "#cf222e",
};
// Single quotes only: this string is interpolated into double-quoted style
// attributes, where a double quote would end the attribute and silently drop
// every declaration after it.
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * @typedef {{ label: string, created: unknown[], modified: unknown[], deleted: unknown[] }} Category
 */

/**
 * The publish notification.
 *
 * @param {Record<string, any>} payload  Figma LIBRARY_PUBLISH payload
 * @param {string} fileKey
 * @param {{ note?: string | null, timezone?: string | null, recipient: string, unsubscribeUrl: string }} opts
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildPublishEmail(payload, fileKey, opts) {
  // Figma's payload carries triggered_by.{id, handle} — no email. Prefer email
  // in case Figma ever adds it (same rule as slack-blocks.js).
  const publisher = payload.triggered_by?.email || payload.triggered_by?.handle || "Unknown user";
  const fileName = String(payload.file_name || "Untitled").slice(0, 100);
  const description =
    typeof payload.description === "string"
      ? payload.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
      : "";
  const note = typeof opts.note === "string" && opts.note.trim() ? opts.note.trim() : "";
  const when = formatWhen(payload.timestamp, opts.timezone);
  const figmaLink = `https://www.figma.com/file/${encodeURIComponent(payload.file_key || fileKey)}`;

  /** @type {Category[]} */
  const categories = [
    {
      label: "Components",
      created: payload.created_components || [],
      modified: payload.modified_components || [],
      deleted: payload.deleted_components || [],
    },
    {
      label: "Styles",
      created: payload.created_styles || [],
      modified: payload.modified_styles || [],
      deleted: payload.deleted_styles || [],
    },
    {
      label: "Variables / Tokens",
      created: payload.created_variables || [],
      modified: payload.modified_variables || [],
      deleted: payload.deleted_variables || [],
    },
  ];
  const changeCount = categories.reduce(
    (n, c) => n + c.created.length + c.modified.length + c.deleted.length,
    0,
  );

  const subject = `${fileName} published by ${publisher}`.slice(0, MAX_SUBJECT_CHARS);
  const preheader =
    changeCount > 0
      ? `${publisher} published ${changeCount} ${changeCount === 1 ? "change" : "changes"} to ${fileName}`
      : `${publisher} published ${fileName}`;

  // ── HTML ──
  const rows = [];
  rows.push(`
      <tr><td style="padding:24px 24px 4px;">
        <div style="font:600 20px/1.3 ${FONT};color:${C.text};">${esc(fileName)}</div>
        <div style="font:13px/1.5 ${FONT};color:${C.muted};margin-top:2px;">Library published in Figma</div>
      </td></tr>`);
  rows.push(`
      <tr><td style="padding:4px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="50%" style="padding:8px 0;vertical-align:top;">${field("Published by", esc(publisher))}</td>
          <td width="50%" style="padding:8px 0;vertical-align:top;">${field("When", esc(when))}</td>
        </tr></table>
      </td></tr>`);
  rows.push(`
      <tr><td style="padding:4px 24px 8px;">${
        description
          ? field("Description", esc(description).replace(/\n/g, "<br>"))
          : field(
              "Description",
              `<span style="color:${C.amber};">No description provided. Please add one when publishing.</span>`,
            )
      }</td></tr>`);
  if (note) {
    rows.push(`
      <tr><td style="padding:4px 24px 8px;">${field("Team note", esc(note).replace(/\n/g, "<br>"))}</td></tr>`);
  }
  rows.push(`
      <tr><td style="padding:8px 24px 0;"><div style="border-top:1px solid ${C.border};"></div></td></tr>`);

  let hasAny = false;
  for (const cat of categories) {
    const groups = [
      ["Added", cat.created, C.success],
      ["Modified", cat.modified, C.amber],
      ["Removed", cat.deleted, C.danger],
    ].filter(([, items]) => /** @type {unknown[]} */ (items).length > 0);
    if (groups.length === 0) continue;
    hasAny = true;
    const parts = groups
      .map(([label, items, color]) => {
        const names = itemNames(/** @type {unknown[]} */ (items));
        return `
          <div style="margin-top:8px;">
            <div style="font:600 12px/1.5 ${FONT};color:${color};">${label} (${names.length})</div>
            ${list(names)}
          </div>`;
      })
      .join("");
    rows.push(`
      <tr><td style="padding:12px 24px 4px;">
        <div style="font:600 13px/1.5 ${FONT};color:${C.text};">${esc(cat.label)}</div>${parts}
      </td></tr>`);
  }
  if (!hasAny) {
    rows.push(`
      <tr><td style="padding:12px 24px 4px;font:italic 12px/1.5 ${FONT};color:${C.muted};">No itemized changes were included in the webhook payload.</td></tr>`);
  }
  rows.push(`
      <tr><td style="padding:20px 24px 24px;">
        <a href="${esc(figmaLink)}" style="display:inline-block;background:${C.brand};color:#ffffff;text-decoration:none;font:600 13px/1 ${FONT};padding:11px 16px;border-radius:6px;">Open in Figma</a>
      </td></tr>`);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${C.page};">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border:1px solid ${C.border};border-radius:8px;font:12px/1.5 ${FONT};color:${C.text};">${rows.join("")}
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
        <tr><td style="padding:16px 8px;font:11px/1.5 ${FONT};color:${C.muted};">
          You're receiving this because ${esc(opts.recipient)} is on the notification list for &ldquo;${esc(fileName)}&rdquo; in Library Pulse, a Figma plugin. Any editor of that file can change the list.<br>
          <a href="${esc(opts.unsubscribeUrl)}" style="color:${C.muted};">Unsubscribe</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  // ── Plain text ──
  const lines = [];
  lines.push(`Library published: ${fileName}`, "");
  lines.push(`Published by: ${publisher}`);
  lines.push(`When: ${when}`);
  lines.push(`Description: ${description || "No description provided."}`);
  if (note) lines.push(`Team note: ${note}`);
  lines.push("");
  for (const cat of categories) {
    const groups = [
      ["Added", cat.created],
      ["Modified", cat.modified],
      ["Removed", cat.deleted],
    ].filter(([, items]) => /** @type {unknown[]} */ (items).length > 0);
    if (groups.length === 0) continue;
    lines.push(cat.label);
    for (const [label, items] of groups) {
      const names = itemNames(/** @type {unknown[]} */ (items));
      lines.push(`  ${label} (${names.length}):`);
      for (const n of names.slice(0, MAX_ITEMS_DISPLAY)) lines.push(`    - ${n}`);
      if (names.length > MAX_ITEMS_DISPLAY) {
        lines.push(`    ...and ${names.length - MAX_ITEMS_DISPLAY} more`);
      }
    }
    lines.push("");
  }
  if (!hasAny) lines.push("No itemized changes were included in the webhook payload.", "");
  lines.push(`Open in Figma: ${figmaLink}`, "", "--");
  lines.push(
    `You're receiving this because ${opts.recipient} is on the notification list for "${fileName}" in Library Pulse, a Figma plugin. Any editor of that file can change the list.`,
  );
  lines.push(`Unsubscribe: ${opts.unsubscribeUrl}`);

  return { subject, html, text: lines.join("\n") };
}

/**
 * The double-opt-in confirmation.
 *
 * @param {{ fileName: string | null | undefined, recipient: string, confirmUrl: string }} opts
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildConfirmEmail(opts) {
  const fileName = String(opts.fileName || "a Figma library").slice(0, 100);
  const subject = `Confirm Library Pulse updates for ${fileName}`.slice(0, MAX_SUBJECT_CHARS);
  const intro = `An editor of the Figma library “${fileName}” added ${opts.recipient} to its publish notifications. Confirm to receive an email each time the library is published.`;
  const expiry = "This link expires in 7 days. If you weren't expecting this, you can ignore it.";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border:1px solid ${C.border};border-radius:8px;font:12px/1.5 ${FONT};color:${C.text};">
        <tr><td style="padding:24px 24px 8px;">
          <div style="font:600 20px/1.3 ${FONT};color:${C.text};">Confirm your address</div>
        </td></tr>
        <tr><td style="padding:8px 24px;font-size:13px;">${esc(intro)}</td></tr>
        <tr><td style="padding:16px 24px 8px;">
          <a href="${esc(opts.confirmUrl)}" style="display:inline-block;background:${C.brand};color:#ffffff;text-decoration:none;font:600 13px/1 ${FONT};padding:11px 16px;border-radius:6px;">Confirm address</a>
        </td></tr>
        <tr><td style="padding:8px 24px 24px;font-size:11px;color:${C.muted};">${esc(expiry)}<br>If the button doesn't work, open this link: <a href="${esc(opts.confirmUrl)}" style="color:${C.muted};word-break:break-all;">${esc(opts.confirmUrl)}</a></td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
        <tr><td style="padding:16px 8px;font:11px/1.5 ${FONT};color:${C.muted};">Sent by Library Pulse, a Figma plugin that tells teams when a design library is published.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    "Confirm your address",
    "",
    intro,
    "",
    `Confirm: ${opts.confirmUrl}`,
    "",
    expiry,
    "",
    "--",
    "Sent by Library Pulse, a Figma plugin that tells teams when a design library is published.",
  ].join("\n");

  return { subject, html, text };
}

/**
 * Publish time in the list's timezone, e.g. "30 Jul 2026, 19:45 Asia/Kolkata
 * (GMT+5:30)". Falls back to UTC when no zone was saved; "just now" when the
 * payload's timestamp is missing or unparseable (same rule as Slack).
 *
 * @param {unknown} raw
 * @param {string | null | undefined} timezone
 * @returns {string}
 */
export function formatWhen(raw, timezone) {
  if (typeof raw !== "string" && typeof raw !== "number") return "just now";
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return "just now";
  const zone = timezone || "UTC";
  let base;
  try {
    base = new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: zone,
    }).format(new Date(ms));
  } catch {
    return `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
  // Add the UTC offset for named zones ("Asia/Kolkata (GMT+5:30)"); UTC
  // itself needs no qualifier.
  let offset = "";
  if (!/^(utc|etc\/utc|gmt)$/i.test(zone)) {
    try {
      const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
        .formatToParts(new Date(ms))
        .find((p) => p.type === "timeZoneName");
      if (part && part.value && part.value !== zone) offset = ` (${part.value})`;
    } catch {
      offset = "";
    }
  }
  return `${base} ${zone}${offset}`;
}

/**
 * @param {string} label
 * @param {string} valueHtml  already escaped
 */
function field(label, valueHtml) {
  return `<div style="font:600 11px/1.4 ${FONT};letter-spacing:.5px;text-transform:uppercase;color:${C.muted};">${esc(label)}</div><div style="font:13px/1.5 ${FONT};color:${C.text};margin-top:2px;">${valueHtml}</div>`;
}

/**
 * Item names from Figma's `{ key, name }` objects (or plain strings), in
 * payload order, unescaped.
 *
 * @param {unknown[]} items
 * @returns {string[]}
 */
function itemNames(items) {
  return items
    .map((item) => {
      if (typeof item === "string") return item;
      const o = /** @type {{ name?: unknown, key?: unknown } | null} */ (item);
      return typeof o?.name === "string" ? o.name : typeof o?.key === "string" ? o.key : "";
    })
    .filter((n) => n.length > 0);
}

/** @param {string[]} names */
function list(names) {
  const shown = names.slice(0, MAX_ITEMS_DISPLAY);
  const rest = names.length - MAX_ITEMS_DISPLAY;
  const items = shown.map((n) => `<li style="margin:1px 0;">${esc(n)}</li>`).join("");
  const more =
    rest > 0
      ? `<div style="font:italic 12px/1.5 ${FONT};color:${C.muted};margin-left:18px;">…and ${rest} more</div>`
      : "";
  return `<ul style="margin:2px 0 0;padding-left:18px;font:12px/1.6 ${FONT};color:${C.text};">${items}</ul>${more}`;
}

/**
 * Attribute-context escape for server-built URLs (token characters are
 * base64url, but escape defensively anyway).
 *
 * @param {string} s
 */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === '"') return "&quot;";
    return "&#39;";
  });
}
