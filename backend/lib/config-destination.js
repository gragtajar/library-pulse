// @ts-check
/**
 * Pure planning for the destination half of a config write (migrations 006
 * and 007): which columns change, which addresses are new and need a
 * confirmation email, and which Google Chat spaces are new and need the app
 * added. Kept I/O-free so every branch — create, edit, and switching a file
 * between Slack, email and Google Chat — is unit-testable; api/config.js
 * does the writes.
 *
 * Deploy-order safety: a request that never mentions `destination` (every
 * plugin build before this feature) only ever touches the columns those
 * builds always wrote, so the backend can ship before the migration runs.
 * And a write names only the columns of the destinations it involves: a new
 * config writes its own (the others keep their empty column defaults), and a
 * switch clears only the destination it leaves. So a column missing for one
 * destination (a migration not yet applied) can't fail another's saves.
 */

import { ValidationError } from "./errors.js";
import {
  assertChannelList,
  assertDestination,
  assertEmailList,
  assertSpaceList,
  assertTimezone,
  assertUuid,
} from "./validators.js";
import { mergeRecipients, normalizeRecipientList } from "./email-recipients.js";

/** @typedef {"slack" | "email" | "gchat"} Destination */
/** @typedef {{ name: string, display_name: string }} Space */
/**
 * @typedef {Object} DestinationPlan
 * @property {Destination} destination  the destination after this write
 * @property {Record<string, unknown>} fields  columns to write
 * @property {string[]} addedEmails  addresses that need a confirmation email
 * @property {Space[]} addedSpaces   spaces the app still has to be added to
 */

/** The columns each destination owns, empty; a switch clears the ones it leaves. */
const EMPTY = {
  slack: { slack_team_id: null, channels: [] },
  email: { email_recipients: [], email_timezone: null },
  gchat: { google_installation_id: null, gchat_spaces: [], gchat_timezone: null },
};

/**
 * Plan the destination columns for a brand-new config.
 *
 * @param {Record<string, unknown>} body
 * @param {string} [now]
 * @returns {DestinationPlan}
 */
export function planCreate(body, now) {
  const destination = assertDestination(body.destination);

  if (destination === "email") {
    const emails = assertEmailList(body.emailRecipients);
    const timezone = assertTimezone(body.timezone);
    const { recipients, added } = mergeRecipients([], emails, now);
    return {
      destination,
      fields: {
        destination,
        email_recipients: recipients,
        email_timezone: timezone,
      },
      addedEmails: added,
      addedSpaces: [],
    };
  }

  if (destination === "gchat") {
    const spaces = assertSpaceList(body.gchatSpaces);
    return {
      destination,
      fields: {
        destination,
        google_installation_id: assertInstallationId(body.googleInstallationId),
        gchat_spaces: spaces,
        gchat_timezone: assertTimezone(body.timezone),
      },
      addedEmails: [],
      addedSpaces: spaces,
    };
  }

  const slackTeamId = typeof body.slackTeamId === "string" ? body.slackTeamId : "";
  if (!slackTeamId) throw new ValidationError("Missing slackTeamId");
  const channels = assertChannelList(body.channels);
  return {
    destination,
    fields: {
      slack_team_id: slackTeamId,
      channels,
      // Only a build that knows about destinations writes the new column.
      ...(body.destination !== undefined ? { destination } : {}),
    },
    addedEmails: [],
    addedSpaces: [],
  };
}

/**
 * Plan the destination columns for an edit of an existing config. Fields the
 * request doesn't mention are left alone; switching destination requires the
 * new destination's full details and clears the old one's.
 *
 * @param {Record<string, unknown>} body
 * @param {{ destination?: unknown, email_recipients?: unknown, gchat_spaces?: unknown, google_installation_id?: unknown }} existing
 * @param {string} [now]
 * @returns {DestinationPlan}
 */
export function planUpdate(body, existing, now) {
  /** @type {Destination} */
  const current =
    existing.destination === "email"
      ? "email"
      : existing.destination === "gchat"
        ? "gchat"
        : "slack";
  const target = body.destination !== undefined ? assertDestination(body.destination) : current;
  const switching = target !== current;

  /** @type {Record<string, unknown>} */
  const fields = {};
  /** @type {string[]} */
  let addedEmails = [];
  /** @type {Space[]} */
  let addedSpaces = [];

  // A build that predates destinations can only send Slack fields; applying
  // them to another destination's config would silently do nothing, so say why.
  if (current !== "slack" && body.destination === undefined && body.channels !== undefined) {
    throw new ValidationError(
      `This file sends ${current === "email" ? "email" : "Google Chat"} notifications. Update the Library Pulse plugin to edit it.`,
    );
  }

  if (target === "email") {
    if (switching || body.emailRecipients !== undefined) {
      const emails = assertEmailList(body.emailRecipients);
      const base = switching ? [] : normalizeRecipientList(existing.email_recipients);
      const merged = mergeRecipients(base, emails, now);
      fields.email_recipients = merged.recipients;
      addedEmails = merged.added;
    }
    if (switching || body.timezone !== undefined) {
      fields.email_timezone = assertTimezone(body.timezone);
    }
    if (switching) {
      Object.assign(fields, { destination: "email" }, EMPTY[current]);
      fields.custom_mentions = []; // mentions are a Slack-only concept
    }
  } else if (target === "gchat") {
    if (switching || body.gchatSpaces !== undefined) {
      const spaces = assertSpaceList(body.gchatSpaces);
      const known = new Set(
        switching ? [] : normalizeExistingSpaces(existing.gchat_spaces).map((s) => s.name),
      );
      fields.gchat_spaces = spaces;
      addedSpaces = spaces.filter((s) => !known.has(s.name));
    }
    if (switching || body.timezone !== undefined) {
      fields.gchat_timezone = assertTimezone(body.timezone);
    }
    // The Google account is named when a file moves to Google Chat; an
    // ordinary edit keeps the one on the config unless a new one is given.
    if (switching || body.googleInstallationId !== undefined) {
      fields.google_installation_id = assertInstallationId(body.googleInstallationId);
    }
    if (switching) {
      Object.assign(fields, { destination: "gchat" }, EMPTY[current]);
      fields.custom_mentions = [];
    }
  } else if (switching) {
    const slackTeamId = typeof body.slackTeamId === "string" ? body.slackTeamId : "";
    if (!slackTeamId) throw new ValidationError("Missing slackTeamId");
    Object.assign(fields, { destination: "slack" }, EMPTY[current]);
    fields.slack_team_id = slackTeamId;
    fields.channels = assertChannelList(body.channels);
  } else {
    if (body.channels !== undefined) fields.channels = assertChannelList(body.channels);
    if (typeof body.slackTeamId === "string" && body.slackTeamId) {
      fields.slack_team_id = body.slackTeamId;
    }
  }

  // A different destination starts with a clean delivery record.
  if (switching) {
    fields.delivery_status = "ok";
    fields.last_delivery_error = null;
  }

  return { destination: target, fields, addedEmails, addedSpaces };
}

/** @param {unknown} v */
function assertInstallationId(v) {
  if (typeof v !== "string" || !v) throw new ValidationError("Missing googleInstallationId");
  return assertUuid(v);
}

/**
 * @param {unknown} v
 * @returns {Space[]}
 */
function normalizeExistingSpaces(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => ({
      name: typeof s === "string" ? s : typeof s?.name === "string" ? s.name : "",
      display_name: typeof s?.display_name === "string" ? s.display_name : "",
    }))
    .filter((s) => s.name);
}
