// @ts-check
/**
 * Pure planning for the destination half of a config write (migration 006):
 * which columns change, and which addresses are new and need a confirmation
 * email. Kept I/O-free so every branch — create, edit, and switching a file
 * between Slack and email — is unit-testable; api/config.js does the writes.
 *
 * Deploy-order safety: a request that never mentions `destination` (every
 * plugin build before this feature) only ever touches the columns those
 * builds always wrote, so the backend can ship before the migration runs.
 */

import { ValidationError } from "./errors.js";
import {
  assertChannelList,
  assertDestination,
  assertEmailList,
  assertTimezone,
} from "./validators.js";
import { mergeRecipients, normalizeRecipientList } from "./email-recipients.js";

/** @typedef {"slack" | "email"} Destination */
/**
 * @typedef {Object} DestinationPlan
 * @property {Destination} destination  the destination after this write
 * @property {Record<string, unknown>} fields  columns to write
 * @property {string[]} addedEmails  addresses that need a confirmation email
 */

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
        slack_team_id: null,
        channels: [],
        email_recipients: recipients,
        email_timezone: timezone,
      },
      addedEmails: added,
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
      // Only a build that knows about destinations writes the new columns.
      ...(body.destination !== undefined
        ? { destination, email_recipients: [], email_timezone: null }
        : {}),
    },
    addedEmails: [],
  };
}

/**
 * Plan the destination columns for an edit of an existing config. Fields the
 * request doesn't mention are left alone; switching destination requires the
 * new destination's full details and clears the old one's.
 *
 * @param {Record<string, unknown>} body
 * @param {{ destination?: unknown, email_recipients?: unknown }} existing
 * @param {string} [now]
 * @returns {DestinationPlan}
 */
export function planUpdate(body, existing, now) {
  /** @type {Destination} */
  const current = existing.destination === "email" ? "email" : "slack";
  const target = body.destination !== undefined ? assertDestination(body.destination) : current;
  const switching = target !== current;

  /** @type {Record<string, unknown>} */
  const fields = {};
  /** @type {string[]} */
  let addedEmails = [];

  if (target === "email") {
    // A build that predates destinations can only send Slack fields; applying
    // them to an email config would silently do nothing, so say why instead.
    if (body.destination === undefined && body.channels !== undefined) {
      throw new ValidationError(
        "This file sends email notifications. Update the Library Pulse plugin to edit it.",
      );
    }
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
      fields.destination = "email";
      fields.slack_team_id = null;
      fields.channels = [];
      fields.custom_mentions = []; // mentions are a Slack-only concept
    }
  } else if (switching) {
    const slackTeamId = typeof body.slackTeamId === "string" ? body.slackTeamId : "";
    if (!slackTeamId) throw new ValidationError("Missing slackTeamId");
    fields.destination = "slack";
    fields.slack_team_id = slackTeamId;
    fields.channels = assertChannelList(body.channels);
    fields.email_recipients = [];
    fields.email_timezone = null;
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

  return { destination: target, fields, addedEmails };
}
