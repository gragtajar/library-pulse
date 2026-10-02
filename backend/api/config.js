// @ts-check
/**
 * /api/config — CRUD for the org-shared, per-file notification config.
 *
 *   GET    ?fileKey=…  → the file's single shared config (+ isOwner), gated by a
 *                        file-access check. No fileKey → legacy: the caller's own
 *                        configs (kept so the currently-live plugin keeps working).
 *   POST   { fileKey, fileName?, destination?, … }
 *                      → create the file's config (or, for the original setter,
 *                        update in place); 409 if another user already owns it.
 *                        Slack:  { slackTeamId, channels }
 *                        Email:  { destination: "email", emailRecipients, timezone }
 *   PUT    { id|fileKey, …updates } → any edit-access user updates channels or
 *                        recipients, the note, or switches destination.
 *
 * A config targets ONE destination (lib/config-destination.js plans the
 * columns). Newly added email addresses are sent a confirmation and stay
 * "pending" until their owner confirms; the response's `emailConfirmations`
 * says how many confirmations went out.
 *   DELETE ?id=…|?fileKey=… → deactivate the config (any edit-access user); the
 *                        original setter also tears down the Figma webhook.
 *
 * Authorization: every request carries `Authorization: Bearer <token>` — a
 * signed session token minted after Figma OAuth (lib/session.js). The caller's
 * Figma user id comes from that token, never the body.
 *
 * Access model (SPEC-batch-2 §0/§4): config is keyed by FILE. Anyone with edit
 * access to a file manages its config. The original setter (`created_by`) is
 * trusted without re-probing — they proved edit access at setup, the same trust
 * as before Batch 2 — so their own flows keep working even before the
 * `webhooks:read` scope is approved. OTHER users are verified with their own
 * Figma token (lib/figma-access.js, needs `webhooks:read`). Creating/deleting the
 * webhook is edit-gated by Figma for free.
 */

import crypto from "node:crypto";
import supabase from "../lib/supabase.js";
import { applyCors, fetchWithTimeout, withErrorHandling } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { requireSession } from "../lib/session.js";
import { ForbiddenError, NotFoundError, UpstreamError, ValidationError } from "../lib/errors.js";
import {
  assertCustomMessage,
  assertFigmaFileKey,
  assertMentionList,
  assertUuid,
} from "../lib/validators.js";
import { assertFileAccess, getFigmaAccessToken } from "../lib/figma-access.js";
import { planCreate, planUpdate } from "../lib/config-destination.js";
import { sendConfirmations } from "../lib/email-delivery.js";
import { ensureAppMemberships } from "../lib/gchat-delivery.js";
import { getInstallation } from "../lib/google-installations.js";

const PG_UNIQUE_VIOLATION = "23505";
// Only ever expose non-secret columns to the client. `bot_token_enc` is never
// selected here; this list documents intent and guards future column additions.
const CONFIG_SELECT =
  "*, slack_installations(slack_team_name), google_installations(google_email, google_hd)";

export default withErrorHandling(
  /**
   * @param {import("../lib/types.js").VercelRequest} req
   * @param {import("../lib/types.js").VercelResponse} res
   */
  async function handler(req, res) {
    if (applyCors(req, res)) return;

    switch (req.method) {
      case "GET":
        return handleGet(req, res);
      case "POST":
        return handlePost(req, res);
      case "PUT":
        return handlePut(req, res);
      case "DELETE":
        return handleDelete(req, res);
      default:
        return res.status(405).json({ error: "Method not allowed" });
    }
  },
);

/**
 * @param {import("../lib/types.js").VercelRequest} req
 * @param {string} name
 * @returns {string}
 */
function queryParam(req, name) {
  const raw = req.query?.[name];
  return typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? "") : "";
}

/**
 * @param {import("../lib/types.js").VercelRequest} req
 * @param {import("../lib/types.js").VercelResponse} res
 */
async function handleGet(req, res) {
  const callerId = requireSession(req);
  const fileKey = queryParam(req, "fileKey");

  // ── New per-file path: the file's shared config ──
  if (fileKey) {
    assertFigmaFileKey(fileKey);

    const { data, error } = await supabase
      .from("configurations")
      .select(CONFIG_SELECT)
      .eq("figma_file_key", fileKey)
      .maybeSingle();

    if (error) {
      logger.error("config_fetch_failed", { err: error });
      throw new UpstreamError("config_fetch_failed");
    }
    if (!data) return res.status(200).json({ config: null });
    // Trust the setter; access-check only OTHER users viewing the shared config.
    if (data.created_by !== callerId) await assertFileAccess(callerId, fileKey);
    return res.status(200).json({ config: data, isOwner: data.created_by === callerId });
  }

  // ── Legacy path (currently-live plugin): the caller's own configs ──
  const { data, error } = await supabase
    .from("configurations")
    .select(CONFIG_SELECT)
    .eq("figma_user_id", callerId)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error("config_fetch_failed", { err: error });
    throw new UpstreamError("config_fetch_failed");
  }
  return res.status(200).json({ configurations: data ?? [] });
}

/**
 * @param {import("../lib/types.js").VercelRequest} req
 * @param {import("../lib/types.js").VercelResponse} res
 */
async function handlePost(req, res) {
  const callerId = requireSession(req);
  const body = /** @type {Record<string, unknown> | null} */ (req.body) ?? {};

  const fileKey = assertFigmaFileKey(body.fileKey);
  const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 200) : null;
  // Validates the whole destination (Slack workspace + channels, or email
  // addresses + timezone) before anything is read or written.
  const createPlan = planCreate(body);

  // Optional team note (migration 004). Only touch the columns when the client
  // sent the fields, so a pre-004 database never sees them. Mentions are a
  // Slack concept: an email config keeps the note as plain text.
  /** @type {Record<string, unknown>} */
  const noteFields = {};
  if (body.customMessage !== undefined) {
    noteFields.custom_message = assertCustomMessage(body.customMessage);
    noteFields.custom_mentions =
      createPlan.destination !== "slack" ? [] : assertMentionList(body.customMentions);
  }

  // One config per file. If it already exists and the caller isn't the setter,
  // they should be shown the shared view rather than clobbering it → 409.
  const { data: existing } = await supabase
    .from("configurations")
    .select(CONFIG_SELECT)
    .eq("figma_file_key", fileKey)
    .maybeSingle();

  if (existing) {
    const isOwner = existing.created_by === callerId;
    if (!isOwner) {
      return res.status(409).json({ error: "config_exists", config: existing, isOwner: false });
    }
    // Owner re-saving (covers the live plugin's edit-via-POST). Update in place,
    // by the same rules as an edit — retained email addresses keep their
    // confirmation state, only new ones get a confirmation.
    const plan = planUpdate(body, existing);
    await assertInstallationUsable(callerId, plan.fields.google_installation_id);
    const { data: updated, error: upErr } = await supabase
      .from("configurations")
      .update({
        figma_file_name: fileName,
        is_active: true,
        ...plan.fields,
        ...noteFields,
      })
      .eq("id", existing.id)
      .select(CONFIG_SELECT)
      .single();
    if (upErr || !updated) {
      logger.error("config_save_failed", { err: upErr });
      throw new UpstreamError("config_save_failed");
    }
    const webhookStatus = await registerWebhookReporting(callerId, fileKey);
    const emailConfirmations = await confirmNewRecipients(updated, plan.addedEmails);
    const spaceMemberships = await addAppToSpaces(updated, plan.addedSpaces);
    return res.status(200).json({
      ...updated,
      webhookStatus,
      isOwner: true,
      ...emailConfirmations,
      ...spaceMemberships,
    });
  }

  // ── Create ── Webhook registration (below) is the edit-access gate: Figma
  // requires "Can edit" + webhooks:write to POST /v2/webhooks, so no read probe.
  await assertInstallationUsable(callerId, createPlan.fields.google_installation_id);
  const { data: config, error: cfgErr } = await supabase
    .from("configurations")
    .insert({
      figma_user_id: callerId,
      created_by: callerId,
      figma_file_key: fileKey,
      figma_file_name: fileName,
      is_active: true,
      ...createPlan.fields,
      ...noteFields,
    })
    .select(CONFIG_SELECT)
    .single();

  if (cfgErr || !config) {
    // Lost a create race → treat as "exists" and return the winning row.
    if (cfgErr && cfgErr.code === PG_UNIQUE_VIOLATION) {
      const { data: raced } = await supabase
        .from("configurations")
        .select(CONFIG_SELECT)
        .eq("figma_file_key", fileKey)
        .maybeSingle();
      return res
        .status(409)
        .json({ error: "config_exists", config: raced, isOwner: raced?.created_by === callerId });
    }
    logger.error("config_save_failed", { err: cfgErr });
    throw new UpstreamError("config_save_failed");
  }

  const webhookStatus = await registerWebhookReporting(callerId, fileKey);
  const emailConfirmations = await confirmNewRecipients(config, createPlan.addedEmails);
  const spaceMemberships = await addAppToSpaces(config, createPlan.addedSpaces);
  return res
    .status(201)
    .json({ ...config, webhookStatus, isOwner: true, ...emailConfirmations, ...spaceMemberships });
}

/**
 * @param {import("../lib/types.js").VercelRequest} req
 * @param {import("../lib/types.js").VercelResponse} res
 */
async function handlePut(req, res) {
  const callerId = requireSession(req);
  const body = /** @type {Record<string, unknown> | null} */ (req.body) ?? {};

  const row = await locateConfig(body.id, body.fileKey);
  if (!row) throw new NotFoundError("config_not_found");

  // Any edit-access user may change a file's shared config. The setter is trusted
  // without a probe; other users are access-checked (needs webhooks:read).
  if (row.created_by !== callerId) await assertFileAccess(callerId, row.figma_file_key);

  // Destination columns: channels / workspace, or email recipients / timezone,
  // including a switch from one destination to the other.
  const plan = planUpdate(body, row);
  /** @type {Record<string, unknown>} */
  const updates = { ...plan.fields };
  if (typeof body.fileName === "string") updates.figma_file_name = body.fileName.slice(0, 200);
  if (typeof body.isActive === "boolean") updates.is_active = body.isActive;
  // Optional team note — sending customMessage (even null/empty to clear it)
  // updates both columns; the mention list is re-validated wholesale. An
  // email config keeps the note as plain text (mentions are Slack-only).
  if (body.customMessage !== undefined) {
    updates.custom_message = assertCustomMessage(body.customMessage);
    updates.custom_mentions =
      plan.destination !== "slack" ? [] : assertMentionList(body.customMentions);
  }

  if (Object.keys(updates).length === 0) {
    throw new ValidationError("No updatable fields provided");
  }
  await assertInstallationUsable(callerId, updates.google_installation_id);

  const { data, error } = await supabase
    .from("configurations")
    .update(updates)
    .eq("id", row.id)
    .select(CONFIG_SELECT)
    .single();

  if (error) {
    logger.error("config_update_failed", { err: error });
    throw new UpstreamError("config_update_failed");
  }
  const emailConfirmations = await confirmNewRecipients(data, plan.addedEmails);
  const spaceMemberships = await addAppToSpaces(data, plan.addedSpaces);
  return res.status(200).json({
    ...data,
    isOwner: row.created_by === callerId,
    ...emailConfirmations,
    ...spaceMemberships,
  });
}

/**
 * @param {import("../lib/types.js").VercelRequest} req
 * @param {import("../lib/types.js").VercelResponse} res
 */
async function handleDelete(req, res) {
  const callerId = requireSession(req);
  const row = await locateConfig(queryParam(req, "id"), queryParam(req, "fileKey"));
  if (!row) throw new NotFoundError("config_not_found");

  // Setter is trusted without a probe; other edit-access users are access-checked.
  if (row.created_by !== callerId) await assertFileAccess(callerId, row.figma_file_key);

  // Any edit-access user can turn notifications off. Deactivate rather than
  // hard-delete so the config (and other editors' channels) survive; a webhook
  // firing into an inactive config is already a safe no-op in webhook.js.
  const { error } = await supabase
    .from("configurations")
    .update({ is_active: false })
    .eq("id", row.id);
  if (error) {
    logger.error("config_deactivate_failed", { err: error });
    throw new UpstreamError("config_delete_failed");
  }

  // Only the original setter tears down the Figma webhook.
  let webhookRemoved = false;
  if (row.created_by === callerId) {
    try {
      await teardownWebhook(callerId, row.figma_file_key);
      webhookRemoved = true;
    } catch (err) {
      logger.warn("webhook_teardown_failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return res.status(200).json({ success: true, deactivated: true, webhookRemoved });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Send the double-opt-in confirmation to addresses this write just added.
 * Returns the fragment to merge into the response (`{}` when there was
 * nothing to send). Never throws — the config is already saved, and a mail
 * outage must not turn that into an error.
 *
 * @param {any} config  the saved row
 * @param {string[]} addedEmails
 * @returns {Promise<{ emailConfirmations?: { sent: number, failed: number, skipped: number } }>}
 */
async function confirmNewRecipients(config, addedEmails) {
  if (addedEmails.length === 0) return {};
  try {
    return { emailConfirmations: await sendConfirmations(config, addedEmails) };
  } catch (err) {
    logger.warn("email_confirmations_failed", {
      config_id: config?.id,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { emailConfirmations: { sent: 0, failed: addedEmails.length, skipped: 0 } };
  }
}

/**
 * Google Chat: add the app to the spaces this save introduced, with the
 * token of the Google account on the config. Never throws: the save already
 * happened; the result tells the plugin which spaces still need attention.
 *
 * @param {any} config  the saved row
 * @param {Array<{ name: string, display_name: string }>} addedSpaces
 * @returns {Promise<{ spaceMemberships?: { added: number, failed: number, errors: string[] } }>}
 */
async function addAppToSpaces(config, addedSpaces) {
  if (addedSpaces.length === 0) return {};
  try {
    const inst = config?.google_installation_id
      ? await getInstallation(config.google_installation_id)
      : null;
    if (!inst) {
      return {
        spaceMemberships: {
          added: 0,
          failed: addedSpaces.length,
          errors: addedSpaces.map(() => "google_not_connected"),
        },
      };
    }
    return { spaceMemberships: await ensureAppMemberships(inst, addedSpaces) };
  } catch (err) {
    logger.warn("gchat_memberships_failed", {
      config_id: config?.id,
      reason: err instanceof Error ? err.message : String(err),
    });
    return {
      spaceMemberships: {
        added: 0,
        failed: addedSpaces.length,
        errors: addedSpaces.map(() => "unknown"),
      },
    };
  }
}

/**
 * A Google account can only be put on a config by the Figma user who signed
 * in with it (installation ids are unguessable UUIDs, but this rules out
 * reusing one that leaked). Called whenever a write names an installation.
 *
 * @param {string} callerId
 * @param {unknown} installationId
 */
async function assertInstallationUsable(callerId, installationId) {
  if (installationId === undefined || installationId === null) return;
  const inst = await getInstallation(String(installationId));
  if (!inst) throw new NotFoundError("google_not_connected");
  if (inst.figma_user_id !== callerId) throw new ForbiddenError("google_installation_forbidden");
  if (inst.revoked_at) throw new ValidationError("google_reauth_required");
}

/**
 * Find a config by uuid `id` or by `fileKey`. Returns the row needed for
 * authorization and destination planning, or null. `*` rather than a column
 * list on purpose: the destination columns (migration 006) must not break a
 * deploy against a not-yet-migrated database — absent columns are simply
 * absent keys, which planUpdate reads as "a Slack config".
 *
 * @param {unknown} idRaw
 * @param {unknown} fileKeyRaw
 * @returns {Promise<{ id: string, figma_file_key: string, created_by: string|null, destination?: unknown, email_recipients?: unknown } | null>}
 */
async function locateConfig(idRaw, fileKeyRaw) {
  if (typeof idRaw === "string" && idRaw) {
    assertUuid(idRaw);
    const { data } = await supabase
      .from("configurations")
      .select("*")
      .eq("id", idRaw)
      .maybeSingle();
    return data ?? null;
  }
  if (typeof fileKeyRaw === "string" && fileKeyRaw) {
    assertFigmaFileKey(fileKeyRaw);
    const { data } = await supabase
      .from("configurations")
      .select("*")
      .eq("figma_file_key", fileKeyRaw)
      .maybeSingle();
    return data ?? null;
  }
  return null;
}

/**
 * Register the file webhook, converting failures into a status string the
 * plugin can act on (rather than a 500 that hides an already-saved config).
 *
 * @param {string} callerId
 * @param {string} fileKey
 * @returns {Promise<string>}
 */
async function registerWebhookReporting(callerId, fileKey) {
  try {
    return await ensureWebhook(callerId, fileKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn("webhook_register_failed", { file_key: fileKey, reason });
    // A revoked/expired setter token → surface figma_revoked so the shared view
    // shows a "reconnect Figma" banner (§6b).
    if (reason === "figma_reauth_required") await markDelivery(fileKey, "figma_revoked", reason);
    return err instanceof ValidationError || err instanceof ForbiddenError
      ? err.message
      : "registration_failed";
  }
}

/**
 * Best-effort: set a file config's delivery_status (revocation surfacing, §6).
 *
 * @param {string} fileKey
 * @param {string} status
 * @param {string} [error]
 */
async function markDelivery(fileKey, status, error) {
  const { error: dbErr } = await supabase
    .from("configurations")
    .update({ delivery_status: status, last_delivery_error: error ?? null })
    .eq("figma_file_key", fileKey);
  if (dbErr) logger.warn("delivery_status_update_failed", { file_key: fileKey, err: dbErr });
}

/**
 * Register a `LIBRARY_PUBLISH` webhook on the file (one per file) using the
 * caller's own Figma token, if one isn't already active. Returns "existing" or
 * "registered".
 *
 * @param {string} figmaUserId
 * @param {string} fileKey
 * @returns {Promise<"existing" | "registered">}
 */
async function ensureWebhook(figmaUserId, fileKey) {
  const { data: existing } = await supabase
    .from("figma_webhooks")
    .select("id")
    .eq("context_id", fileKey)
    .eq("status", "active")
    .maybeSingle();
  if (existing) return "existing";

  const { token } = await getFigmaAccessToken(figmaUserId);
  const passcode = crypto.randomBytes(24).toString("hex");
  const endpoint = `${process.env.PUBLIC_URL}/api/webhook`;

  const regRes = await fetchWithTimeout("https://api.figma.com/v2/webhooks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "LIBRARY_PUBLISH",
      context: "file",
      context_id: fileKey,
      endpoint,
      passcode,
      description: "Library Pulse — publish notifications",
    }),
    timeoutMs: 10_000,
  });

  if (!regRes.ok) {
    const errText = await regRes.text();
    logger.warn("figma_webhook_register_upstream_failed", {
      status: regRes.status,
      body: errText.slice(0, 200),
    });
    // 403 → the user lacks edit access (or webhooks:write); 401 → reconnect.
    if (regRes.status === 403) throw new ForbiddenError("figma_file_permission_denied");
    if (regRes.status === 401) throw new ValidationError("figma_reauth_required");
    throw new UpstreamError(`Figma API ${regRes.status}`);
  }

  /** @type {any} */
  const regData = await regRes.json();
  await supabase.from("figma_webhooks").upsert(
    {
      figma_user_id: figmaUserId,
      context: "file",
      context_id: fileKey,
      webhook_id: String(regData.id),
      passcode,
      registered_by: figmaUserId,
      status: "active",
    },
    { onConflict: "context_id" },
  );

  logger.info("figma_webhook_registered", { file_key: fileKey, webhook_id: regData.id });
  return "registered";
}

/**
 * Delete the file webhook (one per file) from Figma and our table. No-op if
 * none is registered.
 *
 * @param {string} figmaUserId
 * @param {string} fileKey
 */
async function teardownWebhook(figmaUserId, fileKey) {
  const { data: row } = await supabase
    .from("figma_webhooks")
    .select("id, webhook_id")
    .eq("context_id", fileKey)
    .maybeSingle();
  if (!row) return;

  try {
    const { token } = await getFigmaAccessToken(figmaUserId);
    await fetchWithTimeout(`https://api.figma.com/v2/webhooks/${row.webhook_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 10_000,
    });
  } catch (err) {
    logger.warn("figma_webhook_delete_upstream_failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  await supabase.from("figma_webhooks").delete().eq("id", row.id);
}
