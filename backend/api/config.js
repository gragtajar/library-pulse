// @ts-check
/**
 * /api/config — CRUD for notification configurations.
 *
 *   GET    ?figmaUserId=…           → list user's configs
 *   POST   { …newConfig }           → create config + auto-register webhook
 *   PUT    { id, …updates }         → update config
 *   DELETE ?id=…                    → delete config
 *
 * Authorization model (best-effort without a real session layer): every
 * request must carry the calling Figma user's ID via the `X-Figma-User`
 * header. We compare it to the row's `figma_user_id` before mutating —
 * a missing/mismatched header → 403. This is not a substitute for real
 * auth, but it stops casual cross-user enumeration.
 */

import crypto from "node:crypto";
import supabase from "../lib/supabase.js";
import { decrypt } from "../lib/encryption.js";
import { applyCors, fetchWithTimeout, withErrorHandling } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import {
  ForbiddenError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from "../lib/errors.js";
import {
  assertChannelList,
  assertFigmaFileKey,
  assertFigmaTeamId,
  assertFigmaUserId,
  assertUuid,
} from "../lib/validators.js";

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

/** @param {import("../lib/types.js").VercelRequest} req */
function callingUser(req) {
  const raw = req.headers?.["x-figma-user"];
  const userHeader = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  if (!userHeader) throw new ForbiddenError("missing_x_figma_user");
  return assertFigmaUserId(userHeader);
}

/**
 * @param {import("../lib/types.js").VercelRequest} req
 * @param {import("../lib/types.js").VercelResponse} res
 */
async function handleGet(req, res) {
  const callerId = callingUser(req);

  const queryUser = req.query.figmaUserId;
  const figmaUserId =
    typeof queryUser === "string" ? queryUser : Array.isArray(queryUser) ? queryUser[0] : "";
  assertFigmaUserId(figmaUserId);

  if (figmaUserId !== callerId) {
    throw new ForbiddenError("figma_user_mismatch");
  }

  const { data, error } = await supabase
    .from("configurations")
    .select("*, slack_installations(slack_team_name)")
    .eq("figma_user_id", figmaUserId)
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
  const callerId = callingUser(req);
  const body = /** @type {Record<string, unknown> | null} */ (req.body) ?? {};

  const figmaUserId = assertFigmaUserId(body.figmaUserId);
  if (figmaUserId !== callerId) throw new ForbiddenError("figma_user_mismatch");

  const figmaTeamId = assertFigmaTeamId(body.figmaTeamId);
  const fileKey = assertFigmaFileKey(body.fileKey);
  const slackTeamId = typeof body.slackTeamId === "string" ? body.slackTeamId : "";
  if (!slackTeamId) throw new ValidationError("Missing slackTeamId");

  const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 200) : null;
  const channels = assertChannelList(body.channels);

  const { data: config, error: cfgErr } = await supabase
    .from("configurations")
    .upsert(
      {
        figma_user_id: figmaUserId,
        figma_team_id: figmaTeamId,
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

  let webhookStatus = "existing";
  try {
    webhookStatus = await ensureWebhook(figmaUserId, figmaTeamId);
  } catch (err) {
    logger.error("webhook_register_failed", { err });
    webhookStatus = "registration_failed";
  }

  return res.status(201).json({ ...config, webhookStatus });
}

/**
 * @param {import("../lib/types.js").VercelRequest} req
 * @param {import("../lib/types.js").VercelResponse} res
 */
async function handlePut(req, res) {
  const callerId = callingUser(req);
  const body = /** @type {Record<string, unknown> | null} */ (req.body) ?? {};

  const id = typeof body.id === "string" ? body.id : "";
  assertUuid(id);

  // Confirm the caller owns this configuration.
  const { data: row, error: fetchErr } = await supabase
    .from("configurations")
    .select("figma_user_id")
    .eq("id", id)
    .single();
  if (fetchErr || !row) throw new NotFoundError("config_not_found");
  if (row.figma_user_id !== callerId) throw new ForbiddenError("figma_user_mismatch");

  /** @type {Record<string, unknown>} */
  const updates = {};
  if (body.channels !== undefined) updates.channels = assertChannelList(body.channels);
  if (body.fileKey !== undefined) updates.figma_file_key = assertFigmaFileKey(body.fileKey);
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
  const callerId = callingUser(req);
  const idRaw = req.query.id;
  const id = typeof idRaw === "string" ? idRaw : Array.isArray(idRaw) ? idRaw[0] : "";
  assertUuid(id);

  const { data: row, error: fetchErr } = await supabase
    .from("configurations")
    .select("figma_user_id")
    .eq("id", id)
    .single();
  if (fetchErr || !row) throw new NotFoundError("config_not_found");
  if (row.figma_user_id !== callerId) throw new ForbiddenError("figma_user_mismatch");

  const { error } = await supabase.from("configurations").delete().eq("id", id);
  if (error) {
    logger.error("config_delete_failed", { err: error });
    throw new UpstreamError("config_delete_failed");
  }

  return res.status(200).json({ success: true });
}

/**
 * Register a Figma `LIBRARY_PUBLISH` webhook for the team if one isn't
 * already active.
 *
 * @param {string} figmaUserId
 * @param {string} figmaTeamId
 * @returns {Promise<"existing" | "registered">}
 */
async function ensureWebhook(figmaUserId, figmaTeamId) {
  const { data: existing } = await supabase
    .from("figma_webhooks")
    .select("id")
    .eq("figma_team_id", figmaTeamId)
    .eq("status", "active")
    .maybeSingle();
  if (existing) return "existing";

  const { data: tokenRow } = await supabase
    .from("figma_tokens")
    .select("access_token_enc")
    .eq("figma_user_id", figmaUserId)
    .maybeSingle();
  if (!tokenRow) throw new ValidationError("Figma not connected for this user");

  const figmaToken = decrypt(tokenRow.access_token_enc);
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
      team_id: figmaTeamId,
      endpoint,
      passcode,
      description: "Library Pulse — publish notifications",
    }),
    timeoutMs: 10_000,
  });

  if (!regRes.ok) {
    const errText = await regRes.text();
    logger.warn("figma_webhook_register_upstream_failed", { status: regRes.status, body: errText.slice(0, 200) });
    throw new UpstreamError(`Figma API ${regRes.status}`);
  }

  /** @type {any} */
  const regData = await regRes.json();
  await supabase.from("figma_webhooks").insert({
    figma_team_id: figmaTeamId,
    webhook_id: regData.id,
    passcode,
    registered_by: figmaUserId,
    status: "active",
  });

  logger.info("figma_webhook_registered", { figma_team_id: figmaTeamId, webhook_id: regData.id });
  return "registered";
}
