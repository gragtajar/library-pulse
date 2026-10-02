// @ts-check
/**
 * The three Google Chat API calls Library Pulse makes
 * (developers.google.com/workspace/chat/api/reference/rest):
 *
 *   listSpaces     spaces.list, with the USER's token (chat.spaces.readonly):
 *                  "Lists spaces … that the caller is a member of".
 *   addAppToSpace  spaces.members.create, with the USER's token
 *                  (chat.memberships.app): adds "the calling app", member
 *                  name users/app. The app can't add itself with its own token.
 *   postMessage    spaces.messages.create, with the APP's token (chat.bot):
 *                  the update is posted by Library Pulse itself.
 *
 * Every failure is a `ChatApiError` with a short machine-readable code the
 * callers map to a delivery status or a plugin error.
 */

import { createHash } from "node:crypto";
import { fetchWithTimeout } from "./http.js";

export const CHAT_API = "https://chat.googleapis.com/v1";
/** The whole message, contents included (messages.create reference). */
export const CHAT_MESSAGE_MAX_BYTES = 32_000;

export class ChatApiError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   * @param {string} [detail]
   */
  constructor(code, status, detail) {
    super(`chat_api_error:${code}`);
    this.name = "ChatApiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** @typedef {{ name: string, displayName: string, spaceType: string }} ChatSpace */

/**
 * @param {string} accessToken
 * @param {{ pageSize?: number, maxPages?: number }} [opts]
 * @returns {Promise<{ spaces: ChatSpace[], truncated: boolean }>}
 */
export async function listSpaces(accessToken, opts = {}) {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 5;
  /** @type {ChatSpace[]} */
  const spaces = [];
  let pageToken = "";
  let pages = 0;
  do {
    const url = new URL(`${CHAT_API}/spaces`);
    url.searchParams.set("pageSize", String(pageSize));
    // Named spaces only: group chats and DMs have no display name to pick by.
    url.searchParams.set("filter", 'spaceType = "SPACE"');
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await chatRequest(accessToken, "GET", url.toString());
    for (const s of Array.isArray(data.spaces) ? data.spaces : []) {
      if (typeof s?.name !== "string") continue;
      spaces.push({
        name: s.name,
        displayName: typeof s.displayName === "string" ? s.displayName : "",
        spaceType: typeof s.spaceType === "string" ? s.spaceType : "SPACE",
      });
    }
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
    pages++;
  } while (pageToken && pages < maxPages);
  return { spaces, truncated: Boolean(pageToken) };
}

/**
 * Add the Library Pulse app to a space on the user's behalf. Already a member
 * (409 ALREADY_EXISTS) counts as done.
 *
 * @param {string} accessToken  the user's token
 * @param {string} spaceName    "spaces/…"
 */
export async function addAppToSpace(accessToken, spaceName) {
  assertSpaceName(spaceName);
  try {
    await chatRequest(accessToken, "POST", `${CHAT_API}/${spaceName}/members`, {
      member: { name: "users/app", type: "BOT" },
    });
  } catch (err) {
    if (err instanceof ChatApiError && err.status === 409) return;
    throw err;
  }
}

/**
 * Post a text message as the app. `requestId` is derived from the event and
 * the space, so a retried send after a partial failure can't post twice
 * (messages.create: "Specifying a request ID makes the request idempotent").
 *
 * @param {string} appToken   the app's token (chat.bot)
 * @param {string} spaceName  "spaces/…"
 * @param {string} text
 * @param {string} idempotencyKey
 * @returns {Promise<{ name: string }>}
 */
export async function postMessage(appToken, spaceName, text, idempotencyKey) {
  assertSpaceName(spaceName);
  const url = new URL(`${CHAT_API}/${spaceName}/messages`);
  url.searchParams.set("requestId", uuidFrom(idempotencyKey));
  const data = await chatRequest(appToken, "POST", url.toString(), { text });
  return { name: typeof data.name === "string" ? data.name : "" };
}

/**
 * @param {string} token
 * @param {"GET" | "POST"} method
 * @param {string} url
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function chatRequest(token, method, url, body) {
  /** @type {Response} */
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs: 8_000,
    });
  } catch (err) {
    throw new ChatApiError("network", 0, err instanceof Error ? err.message : String(err));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ChatApiError(errorCode(res.status, data), res.status, data?.error?.message);
  }
  return data;
}

/**
 * @param {number} status
 * @param {any} data
 */
function errorCode(status, data) {
  const reason = String(data?.error?.status || "").toUpperCase();
  if (status === 401) return "unauthenticated";
  if (status === 403) return reason === "PERMISSION_DENIED" ? "permission_denied" : "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "already_exists";
  if (status === 429) return "rate_limited";
  return `http_${status}`;
}

/** @param {string} name */
export function assertSpaceName(name) {
  if (typeof name !== "string" || !/^spaces\/[A-Za-z0-9_-]{1,128}$/.test(name)) {
    throw new ChatApiError("invalid_space_name", 0);
  }
}

/**
 * A stable UUID-shaped id from any string (for the request id).
 * @param {string} key
 */
function uuidFrom(key) {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
