// @ts-check
/**
 * The Google Chat text for a Figma `LIBRARY_PUBLISH` payload: the same facts
 * as the Slack message and the email (publisher, time, description, team
 * note, added / modified / removed items per category, link to the file), in
 * Chat's own markup (developers.google.com/workspace/chat/format-messages):
 * `*bold*`, `_italic_`, `<url|text>`, lines starting with `- ` as bullets.
 *
 * Every user-controlled value goes through `escapeChat`, which blanks the
 * two characters Chat gives meaning to inside text: `<` and `>`. Without it a
 * component named `<users/all>` would ping the whole space.
 *
 * Chat has no per-viewer time token, so the time is rendered in the zone of
 * the editor who saved the spaces, like the email does.
 */

import { formatWhen } from "./email-message.js";
import { CHAT_MESSAGE_MAX_BYTES } from "./google-chat.js";

const MAX_ITEMS_DISPLAY = 20;
const MAX_DESCRIPTION_CHARS = 1500;
const MAX_NOTE_CHARS = 500;

/** @param {unknown} v */
export function escapeChat(v) {
  return String(v ?? "")
    .replace(/</g, "‹")
    .replace(/>/g, "›");
}

/**
 * @param {Record<string, any>} payload
 * @param {string} fileKey
 * @param {{ note?: string | null, timezone?: string | null }} [opts]
 * @returns {string}
 */
export function buildChatText(payload, fileKey, opts = {}) {
  const fileName = escapeChat(String(payload.file_name || "Untitled").slice(0, 100));
  const publisher = escapeChat(
    payload.triggered_by?.email || payload.triggered_by?.handle || "Unknown user",
  );
  const when = formatWhen(payload.timestamp, opts.timezone);
  const description =
    typeof payload.description === "string"
      ? payload.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
      : "";
  const note = typeof opts.note === "string" ? opts.note.trim().slice(0, MAX_NOTE_CHARS) : "";
  const link = `https://www.figma.com/file/${encodeURIComponent(payload.file_key || fileKey)}`;

  const categories = [
    {
      label: "Components",
      created: payload.created_components,
      modified: payload.modified_components,
      deleted: payload.deleted_components,
    },
    {
      label: "Styles",
      created: payload.created_styles,
      modified: payload.modified_styles,
      deleted: payload.deleted_styles,
    },
    {
      label: "Variables",
      created: payload.created_variables,
      modified: payload.modified_variables,
      deleted: payload.deleted_variables,
    },
  ].map((c) => ({
    label: c.label,
    created: names(c.created),
    modified: names(c.modified),
    deleted: names(c.deleted),
  }));

  /** @param {boolean} withNames */
  const compose = (withNames) => {
    const lines = [];
    lines.push(`*📦 Library published: ${fileName}*`);
    lines.push(`Published by *${publisher}* · ${when}`);
    lines.push(
      description
        ? `*Description:* ${escapeChat(description)}`
        : "_No description provided. Please add one when publishing._",
    );
    if (note) lines.push(`💬 ${escapeChat(note)}`);

    let any = false;
    for (const c of categories) {
      const total = c.created.length + c.modified.length + c.deleted.length;
      if (total === 0) continue;
      any = true;
      lines.push("");
      lines.push(
        `*${c.label}:* ${c.created.length} added, ${c.modified.length} modified, ${c.deleted.length} removed`,
      );
      if (withNames) {
        if (c.created.length) lines.push(`- Added: ${list(c.created)}`);
        if (c.modified.length) lines.push(`- Modified: ${list(c.modified)}`);
        if (c.deleted.length) lines.push(`- Removed: ${list(c.deleted)}`);
      }
    }
    if (!any) {
      lines.push("");
      lines.push("_No itemized changes were included in the publish._");
    }
    lines.push("");
    lines.push(`<${link}|Open in Figma> · Library Pulse`);
    return lines.join("\n");
  };

  // Stay under Chat's whole-message limit: first without item names, and if
  // even that is too long, cut the description.
  let text = compose(true);
  if (Buffer.byteLength(text, "utf8") > CHAT_MESSAGE_MAX_BYTES - 500) text = compose(false);
  if (Buffer.byteLength(text, "utf8") > CHAT_MESSAGE_MAX_BYTES - 500) {
    text = text.slice(0, 20_000) + "\n_…_";
  }
  return text;
}

/**
 * @param {unknown} items
 * @returns {string[]}
 */
function names(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => (typeof it === "string" ? it : it?.name))
    .filter((n) => typeof n === "string" && n.length > 0)
    .map((n) => escapeChat(String(n).slice(0, 80)));
}

/** @param {string[]} all */
function list(all) {
  const shown = all.slice(0, MAX_ITEMS_DISPLAY);
  const rest = all.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` _…and ${rest} more_` : "");
}

/** The welcome / help / unknown-command replies the app sends in Chat. */
export const CHAT_REPLIES = {
  welcome:
    "Hi, I'm *Library Pulse*. I post an update here each time a Figma library that's connected to this space is published.\n" +
    "Connect a library from the Library Pulse plugin in Figma: choose *Google Chat* in step 2 and pick this space.\n" +
    "Mention me with *help* for the commands.",
  help:
    "*Library Pulse* posts an update here each time a connected Figma library is published.\n" +
    "- *help*: this message\n" +
    "- *stop*: pause updates in this space\n" +
    "- *start*: resume updates in this space\n" +
    "To connect or disconnect a library, use the Library Pulse plugin in Figma. Support: https://rajatg.in/library-pulse-plugin#support",
  stopped: "Updates to this space are paused. Mention me with *start* to resume.",
  started: "Updates to this space are on again.",
  unknown: "I didn't understand that. Mention me with *help* for the commands.",
};
