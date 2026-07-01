// @ts-check
/**
 * Build a rich Slack Block Kit message from a Figma `LIBRARY_PUBLISH` payload.
 *
 * Every user-controlled value (file name, publisher handle, item names,
 * description) is escaped through `escapeSlack` before insertion into
 * `mrkdwn` blocks — Slack only treats `&`, `<`, `>` as special there, so a
 * malicious component name like `<!channel>` won't ping the channel.
 */

import { escapeSlack } from "./escape.js";

const MAX_ITEMS_DISPLAY = 20;
const MAX_DESCRIPTION_CHARS = 1500;

/**
 * @param {Record<string, any>} payload
 * @param {string} fileKey
 */
export function buildSlackBlocks(payload, fileKey) {
  // Figma's LIBRARY_PUBLISH payload only carries triggered_by.{id, handle} —
  // no email (verified against Figma's webhook docs). Prefer email in case
  // Figma ever adds it; otherwise the handle (display name) is what identifies
  // the publisher. The webhook fires for ANY editor who publishes the file, so
  // this correctly reflects whoever actually published, not who set it up.
  const publisher = payload.triggered_by?.email || payload.triggered_by?.handle || "Unknown user";
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  const fileName = payload.file_name || "Untitled";
  const timestamp = payload.timestamp
    ? new Date(payload.timestamp).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "just now";
  const figmaLink = `https://www.figma.com/file/${encodeURIComponent(payload.file_key || fileKey)}`;

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

  /** @type {any[]} */
  const blocks = [];

  // ── Header ── (plain_text is auto-escaped by Slack)
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `📦 Library Published — ${String(fileName).slice(0, 100)}`,
      emoji: true,
    },
  });

  // ── Publisher + timestamp ──
  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Published by:*\n${escapeSlack(publisher)}` },
      { type: "mrkdwn", text: `*When:*\n${escapeSlack(timestamp)}` },
    ],
  });

  // ── Description ──
  if (description) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Description:*\n${escapeSlack(description.slice(0, MAX_DESCRIPTION_CHARS))}`,
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "⚠️ *Description:* _No description provided — please add one when publishing!_",
      },
    });
  }

  blocks.push({ type: "divider" });

  let hasAny = false;
  for (const cat of categories) {
    /** @type {string[]} */
    const parts = [];
    if (cat.created.length > 0)
      parts.push(`➕ *Added (${cat.created.length}):*\n${fmtItems(cat.created)}`);
    if (cat.modified.length > 0)
      parts.push(`✏️ *Modified (${cat.modified.length}):*\n${fmtItems(cat.modified)}`);
    if (cat.deleted.length > 0)
      parts.push(`🗑️ *Removed (${cat.deleted.length}):*\n${fmtItems(cat.deleted)}`);

    if (parts.length > 0) {
      hasAny = true;
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${cat.label}*` } });
      for (const part of parts) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: part } });
      }
      blocks.push({ type: "divider" });
    }
  }

  if (!hasAny) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No itemized changes were included in the webhook payload._",
      },
    });
    blocks.push({ type: "divider" });
  }

  // ── Footer ──
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `<${figmaLink}|Open in Figma> · Library Pulse` }],
  });

  return blocks;
}

/**
 * Format a list of changed items for Slack. Accepts `{ key, name }` objects
 * or plain strings; everything is `escapeSlack`'d before output.
 *
 * @param {Array<string | { name?: string, key?: string }>} items
 */
function fmtItems(items) {
  const names = items
    .map((item) => (typeof item === "string" ? item : item.name || item.key || ""))
    .filter((n) => typeof n === "string" && n.length > 0)
    .map(escapeSlack);

  const shown = names.slice(0, MAX_ITEMS_DISPLAY);
  const rest = names.length - MAX_ITEMS_DISPLAY;

  let result = shown.map((n) => `• ${n}`).join("\n");
  if (rest > 0) result += `\n_…and ${rest} more_`;
  return result;
}

/**
 * Plain-text fallback (Slack notifications/unfurls require a `text` field).
 *
 * @param {Record<string, any>} payload
 */
export function fallbackText(payload) {
  const fileName = payload.file_name || "a Figma library";
  const publisher = payload.triggered_by?.email || payload.triggered_by?.handle || "Someone";
  return `📦 ${publisher} published changes to ${fileName}`;
}
