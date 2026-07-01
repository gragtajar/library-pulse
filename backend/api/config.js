// @ts-check
/**
 * /api/config — CRUD for notification configurations.
 *
 *   GET    → list the caller's configs
 *   POST   { fileKey, fileName?, slackTeamId, channels } → create + register webhook
 *   PUT    { id, …updates } → update config
 *   DELETE ?id=…            → delete config (and tear down its Figma webhook)
 *
 * Authorization: every request must carry `Authorization: Bearer <token>`,
 * a signed session token minted after Figma OAuth (see lib/session.js). The
 * caller's Figma user id is derived from that token — never from the request
 * body or a self-asserted header — so one user cannot act on another's configs.
 *
 * Webhook model: file-context. When a config is saved we register a Figma
 * `LIBRARY_PUBLISH` webhook on the *selected file* using the *caller's own*
 * Figma OAuth token. This only needs "Can edit" on the file, so it works for
 * any installer — no shared admin token, no team-admin requirement, no Team ID.
 */

import crypto from "node:crypto";
import supabase from "../lib/supabase.js";
import { decrypt } from "../lib/encryption.js";
import { applyCors, fetchWithTimeout, withErrorHandling } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { requireSession } from "../lib/session.js";
import { ForbiddenError, NotFoundError, UpstreamError, ValidationError } from "../lib/errors.js";
import { assertChannelList, assertFigmaFileKey, assertUuid } from "../lib/validators.js";

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
 * @param {import("../lib/types.js").VercelResponse} res
 */
async function handleGet(req, res) {
  const callerId = requireSession(req);

  const { data, error } = await supabase
    .from("configurations")
    .select("*, slack_installations(slack_team_name)")
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
  const slackTeamId = typeof body.slackTeamId === "string" ? body.slackTeamId : "";
  if (!slackTeamId) throw new ValidationError("Missing slackTeamId");

  const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 200) : null;
  const channels = assertChannelList(body.channels);

  const { data: config, error: cfgErr } = await supabase
    .from("configurations")
    .upsert(
      {
        figma_user_id: callerId,
        figma_file_key: fileKey,
        figma_file_name: fileName,
        slack_team_id: slackTeamId,
        channels,
        is_active: true,
      },
      { onConflict: "figma_user_id,figma_file_key" },
    )
    .select()
    .single();

  if (cfgErr || !config) {
    logger.error("config_save_failed", { err: cfgErr });
    throw new UpstreamError("config_save_failed");
  }

  // Register the file-context webhook. If this fails (e.g. Figma token expired,
  // or the user lacks edit access), surface it — the config exists but won't
  // deliver until the webhook is registered. We report status, not a 500, so
  // the plugin can show an actionable message.
  let webhookStatus;
  try {
    webhookStatus = await ensureWebhook(callerId, fileKey);
  } catch (err) {
    logger.warn("webhook_register_failed", {
      file_key: fileKey,
      reason: err instanceof Error ? err.message : String(err),
    });
    webhookStatus =
      err instanceof ValidationError || err instanceof ForbiddenError
        ? err.message
        : "registration_failed";
  }

  return res.status(201).json({ ...config, webhookStatus });
}

/**
 * @param {import("../lib/types.js").VercelRequest} req
 * @param {import("../lib/types.js").VercelResponse} res
 */
async function handlePut(req, res) {
  const callerId = requireSession(req);
  const body = /** @type {Record<string, unknown> | null} */ (req.body) ?? {};

  const id = typeof body.id === "string" ? body.id : "";
  assertUuid(id);

  const { data: row, error: fetchErr } = await supabase
    .from("configurations")
    .select("figma_user_id")
    .eq("id", id)
    .single();
  if (fetchErr || !row) throw new NotFoundError("config_not_found");
  if (row.figma_user_id !== callerId) throw new ForbiddenError("not_owner");

  /** @type {Record<string, unknown>} */
  const updates = {};
  if (body.channels !== undefined) updates.channels = assertChannelList(body.channels);
  if (typeof body.fileName === "string") updates.figma_file_name = body.fileName.slice(0, 200);
  if (typeof body.isActive === "boolean") updates.is_active = body.isActive;

  if (Object.keys(updates).length === 0) {
    throw new ValidationError("No updatable fields provided");
  }

  const { data, error } = await supabase
    .from("configurations")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    logger.error("config_update_failed", { err: error });
    throw new UpstreamError("config_update_failed");
  }

  return res.status(200).json(data);
}

/**
 * @param {import("../lib/types.js").VercelRequest} req
 * @param {import("../lib/types.js").VercelResponse} res
 */
async function handleDelete(req, res) {
  const callerId = requireSession(req);
  const idRaw = req.query.id;
  const id = typeof idRaw === "string" ? idRaw : Array.isArray(idRaw) ? idRaw[0] : "";
  assertUuid(id);

  const { data: row, error: fetchErr } = await supabase
    .from("configurations")
    .select("figma_user_id, figma_file_key")
    .eq("id", id)
    .single();
  if (fetchErr || !row) throw new NotFoundError("config_not_found");
  if (row.figma_user_id !== callerId) throw new ForbiddenError("not_owner");

  const { error } = await supabase.from("configurations").delete().eq("id", id);
  if (error) {
    logger.error("config_delete_failed", { err: error });
    throw new UpstreamError("config_delete_failed");
  }

  // Best-effort: tear down the file webhook so it stops firing once nobody
  // is listening. Failure here is non-fatal (the config is already gone).
  try {
    await teardownWebhook(callerId, row.figma_file_key);
  } catch (err) {
    logger.warn("webhook_teardown_failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  return res.status(200).json({ success: true });
}

// ── Figma webhook helpers ──────────────────────────────────────────────────

/**
 * Decrypt the caller's stored Figma OAuth access token, rejecting if they
 * haven't connected Figma or the token has expired (they must reconnect).
 *
 * @param {string} figmaUserId
 * @returns {Promise<string>}
 */
async function getFigmaAccessToken(figmaUserId) {
  const { data: tok } = await supabase
    .from("figma_tokens")
    .select("access_token_enc, expires_at")
    .eq("figma_user_id", figmaUserId)
    .maybeSingle();

  if (!tok || !tok.access_token_enc) {
    throw new ValidationError("figma_not_connected");
  }
  if (tok.expires_at && new Date(tok.expires_at).getTime() < Date.now()) {
    throw new ValidationError("figma_reauth_required");
  }
  return decrypt(tok.access_token_enc);
}

/**
 * Register a `LIBRARY_PUBLISH` webhook on the given file (file context) using
 * the caller's own Figma token, if one isn't already active for this
 * (user, file). Returns "existing" or "registered".
 *
 * @param {string} figmaUserId
 * @param {string} fileKey
 * @returns {Promise<"existing" | "registered">}
 */
async function ensureWebhook(figmaUserId, fileKey) {
  const { data: existing } = await supabase
    .from("figma_webhooks")
    .select("id")
    .eq("figma_user_id", figmaUserId)
    .eq("context_id", fileKey)
    .eq("status", "active")
    .maybeSingle();
  if (existing) return "existing";

  const figmaToken = await getFigmaAccessToken(figmaUserId);
  const passcode = crypto.randomBytes(24).toString("hex");
  const endpoint = `${process.env.PUBLIC_URL}/api/webhook`;

  const regRes = await fetchWithTimeout("https://api.figma.com/v2/webhooks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${figmaToken}`,
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
    // 403 here almost always means the user lacks edit access to the file or
    // the OAuth token is missing the webhooks:write scope.
    if (regRes.status === 403) throw new ForbiddenError("figma_file_permission_denied");
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
    { onConflict: "figma_user_id,context_id" },
  );

  logger.info("figma_webhook_registered", { file_key: fileKey, webhook_id: regData.id });
  return "registered";
}

/**
 * Delete the file webhook for a (user, file) from Figma and our table.
 * No-op if none is registered.
 *
 * @param {string} figmaUserId
 * @param {string} fileKey
 */
async function teardownWebhook(figmaUserId, fileKey) {
  const { data: row } = await supabase
    .from("figma_webhooks")
    .select("id, webhook_id")
    .eq("figma_user_id", figmaUserId)
    .eq("context_id", fileKey)
    .maybeSingle();
  if (!row) return;

  try {
    const figmaToken = await getFigmaAccessToken(figmaUserId);
    await fetchWithTimeout(`https://api.figma.com/v2/webhooks/${row.webhook_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${figmaToken}` },
      timeoutMs: 10_000,
    });
  } catch (err) {
    // If the token's gone we can't delete it upstream; drop our row anyway so
    // we don't treat a dead webhook as active.
    logger.warn("figma_webhook_delete_upstream_failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  await supabase.from("figma_webhooks").delete().eq("id", row.id);
}
