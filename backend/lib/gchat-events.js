// @ts-check
/**
 * Google Chat interaction events, delivered to /api/gchat/events
 * (developers.google.com/workspace/chat/receive-respond-interactions):
 *
 *   ADDED_TO_SPACE      remember the space, say hello.
 *   REMOVED_FROM_SPACE  remember that the app is gone (publishes skip it).
 *   MESSAGE             an @mention: help / stop / start, else a short hint.
 *   anything else       acknowledge with an empty response.
 *
 * Every request carries a Google-signed OIDC ID token for our endpoint URL
 * (the Chat app is configured with Authentication Audience = HTTP endpoint
 * URL); it is verified before anything is read
 * (developers.google.com/workspace/chat/verify-requests-from-chat). A reply
 * is sent synchronously as a `Message`, which needs no authentication.
 */

import { OAuth2Client } from "google-auth-library";
import supabase from "./supabase.js";
import { logger } from "./logger.js";
import { googlePublicUrl } from "./google-oauth.js";
import { CHAT_REPLIES } from "./gchat-message.js";

export const CHAT_ISSUER_EMAIL = "chat@system.gserviceaccount.com";

/** The audience Chat puts in the ID token: the configured endpoint URL. */
export function eventsAudience() {
  return `${googlePublicUrl()}/api/gchat/events`;
}

/**
 * @param {string | undefined} authorization  the Authorization header
 * @param {{ client?: OAuth2Client }} [opts]  test seam
 * @returns {Promise<boolean>}
 */
export async function verifyChatRequest(authorization, opts = {}) {
  const bearer = typeof authorization === "string" ? authorization.replace(/^Bearer\s+/i, "") : "";
  if (!bearer || bearer.length > 4096) return false;
  try {
    const client = opts.client ?? new OAuth2Client();
    const ticket = await client.verifyIdToken({ idToken: bearer, audience: eventsAudience() });
    const payload = ticket.getPayload();
    return Boolean(payload && payload.email_verified && payload.email === CHAT_ISSUER_EMAIL);
  } catch (err) {
    logger.warn("gchat_event_token_invalid", {
      reason: err instanceof Error ? err.message.slice(0, 120) : String(err),
    });
    return false;
  }
}

/**
 * Handle one event. Returns the JSON to answer with (a Message, or `{}`).
 *
 * @param {any} event
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handleChatEvent(event) {
  const type = typeof event?.type === "string" ? event.type : "";
  const space = event?.space ?? {};
  const spaceName = typeof space.name === "string" ? space.name : "";
  const user = event?.user ?? {};

  if (!spaceName && type !== "") {
    logger.warn("gchat_event_without_space", { type });
    return {};
  }

  if (type === "ADDED_TO_SPACE") {
    await rememberSpace(space, user, { app_member: true, removed_at: null, muted: false });
    logger.info("gchat_added_to_space", { space: spaceName, space_type: space.spaceType });
    // An @mention that adds the app carries the message too; answer it.
    const command = commandOf(event?.message);
    if (command && command !== "help") return { text: replyFor(command, spaceName, true) };
    return { text: CHAT_REPLIES.welcome };
  }

  if (type === "REMOVED_FROM_SPACE") {
    await rememberSpace(space, user, { app_member: false, removed_at: new Date().toISOString() });
    logger.info("gchat_removed_from_space", { space: spaceName });
    return {};
  }

  if (type === "MESSAGE") {
    const command = commandOf(event?.message);
    if (command === "stop") await setMuted(spaceName, true);
    if (command === "start") await setMuted(spaceName, false);
    return { text: replyFor(command, spaceName, false) };
  }

  return {};
}

/**
 * @param {any} message
 * @returns {"help" | "stop" | "start" | "unknown" | ""}
 */
function commandOf(message) {
  const raw = typeof message?.argumentText === "string" ? message.argumentText : "";
  const word = raw.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!word) return "";
  if (word === "help" || word === "stop" || word === "start") return word;
  return "unknown";
}

/**
 * @param {"help" | "stop" | "start" | "unknown" | ""} command
 * @param {string} spaceName
 * @param {boolean} justAdded
 */
function replyFor(command, spaceName, justAdded) {
  if (command === "stop") return CHAT_REPLIES.stopped;
  if (command === "start") return CHAT_REPLIES.started;
  if (command === "help" || command === "")
    return justAdded ? CHAT_REPLIES.welcome : CHAT_REPLIES.help;
  return CHAT_REPLIES.unknown;
}

/**
 * @param {any} space
 * @param {any} user
 * @param {Record<string, unknown>} patch
 */
async function rememberSpace(space, user, patch) {
  const { error } = await supabase.from("gchat_spaces").upsert(
    {
      space_name: space.name,
      display_name: typeof space.displayName === "string" ? space.displayName.slice(0, 128) : null,
      space_type: typeof space.spaceType === "string" ? space.spaceType : null,
      added_by: typeof user?.name === "string" ? user.name : null,
      last_event_at: new Date().toISOString(),
      ...patch,
    },
    { onConflict: "space_name" },
  );
  if (error) logger.warn("gchat_space_upsert_failed", { space: space.name, err: error });
}

/**
 * @param {string} spaceName
 * @param {boolean} muted
 */
async function setMuted(spaceName, muted) {
  const { error } = await supabase
    .from("gchat_spaces")
    .update({ muted, last_event_at: new Date().toISOString() })
    .eq("space_name", spaceName);
  if (error) logger.warn("gchat_space_mute_failed", { space: spaceName, err: error });
}
