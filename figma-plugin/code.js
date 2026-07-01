// @ts-check
/// <reference types="@figma/plugin-typings" />
/**
 * Library Pulse — Figma plugin sandbox.
 *
 * Runs on the plugin's main thread inside Figma. Has access to the plugin
 * API (file info, current user, client storage) but no network. Communicates
 * with the UI iframe (`ui.html`) over `postMessage`.
 *
 * Message contract (sandbox → UI): see `MESSAGES_TO_UI` below.
 * Message contract (UI → sandbox): see the switch in `figma.ui.onmessage`.
 *
 * Best practice: every async handler is wrapped in `safe()` so an unexpected
 * throw produces a `figma.notify(...)` instead of silently leaving the UI
 * waiting forever.
 */

// Strict allow-lists for UI → sandbox messages.
const ALLOWED_UI_MESSAGE_TYPES = new Set([
  "ui-ready",
  "close",
  "get-storage",
  "set-storage",
  "delete-storage",
  "open-url",
  "notify",
  "resize",
]);

// Same-namespace prefix for all clientStorage keys → easy to wipe.
const STORAGE_PREFIX = "lp/v1/";

// Hard cap so a runaway UI can't fill clientStorage (5 MB total per plugin).
const MAX_STORAGE_VALUE_BYTES = 200 * 1024;

// The context we push to the UI. Built once, sent both proactively and again
// when the UI says it's ready — see below.
const INIT_PAYLOAD = {
  type: "init",
  fileKey: figma.fileKey != null ? figma.fileKey : null,
  fileName: figma.root && figma.root.name ? figma.root.name : "",
  currentUser: figma.currentUser
    ? { id: figma.currentUser.id, name: figma.currentUser.name }
    : null,
};

figma.showUI(__html__, { width: 420, height: 600, themeColors: true });

// Proactive push. This can race the UI before its message listener is attached
// (a known Figma gotcha that left the UI stuck on "Loading…"), so the UI also
// sends a "ui-ready" message and we re-send INIT_PAYLOAD in response.
figma.ui.postMessage(INIT_PAYLOAD);

figma.ui.onmessage = async (/** @type {any} */ msg) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
    figma.notify("Library Pulse: malformed UI message", { error: true });
    return;
  }
  if (!ALLOWED_UI_MESSAGE_TYPES.has(msg.type)) {
    figma.notify(`Library Pulse: unknown message type "${msg.type}"`, { error: true });
    return;
  }

  await safe(msg.type, async () => {
    switch (msg.type) {
      case "ui-ready":
        // The UI finished loading and attached its listener — (re)send context.
        figma.ui.postMessage(INIT_PAYLOAD);
        return;

      case "close":
        figma.closePlugin();
        return;

      case "get-storage": {
        const key = scopedKey(requireString(msg.key, "key"));
        const value = await figma.clientStorage.getAsync(key);
        figma.ui.postMessage({
          type: "storage-result",
          key: msg.key,
          value: value != null ? value : null,
        });
        return;
      }

      case "set-storage": {
        const key = scopedKey(requireString(msg.key, "key"));
        const valueStr = JSON.stringify(msg.value != null ? msg.value : null);
        if (valueStr.length > MAX_STORAGE_VALUE_BYTES) {
          throw new Error(
            `Storage value for "${msg.key}" exceeds ${MAX_STORAGE_VALUE_BYTES} bytes`,
          );
        }
        await figma.clientStorage.setAsync(key, msg.value != null ? msg.value : null);
        figma.ui.postMessage({ type: "storage-saved", key: msg.key });
        return;
      }

      case "delete-storage": {
        const key = scopedKey(requireString(msg.key, "key"));
        await figma.clientStorage.deleteAsync(key);
        figma.ui.postMessage({ type: "storage-deleted", key: msg.key });
        return;
      }

      case "open-url": {
        const url = requireString(msg.url, "url");
        // Only allow https — never let the UI ask the sandbox to open
        // a file://, data:, or javascript: URL.
        if (!/^https:\/\//.test(url)) {
          throw new Error(`Refusing to open non-https URL: ${url}`);
        }
        figma.openExternal(url);
        return;
      }

      case "notify": {
        const message = requireString(msg.message, "message").slice(0, 200);
        figma.notify(message, {
          timeout: typeof msg.timeout === "number" ? msg.timeout : 3000,
          error: msg.error === true,
        });
        return;
      }

      case "resize": {
        const w = typeof msg.width === "number" ? clamp(msg.width, 320, 800) : 420;
        const h = typeof msg.height === "number" ? clamp(msg.height, 240, 1000) : 580;
        figma.ui.resize(w, h);
        return;
      }
    }
  });
};

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * @param {string} type
 * @param {() => Promise<void>} fn
 */
async function safe(type, fn) {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    figma.notify(`Library Pulse error (${type}): ${message}`, { error: true, timeout: 5000 });
    figma.ui.postMessage({ type: "error", source: type, message });
  }
}

/**
 * @param {unknown} v
 * @param {string} name
 * @returns {string}
 */
function requireString(v, name) {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing or invalid "${name}" field`);
  }
  return v;
}

/** @param {string} key */
function scopedKey(key) {
  return STORAGE_PREFIX + key;
}

/**
 * @param {number} n
 * @param {number} min
 * @param {number} max
 */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
