// @ts-check
/**
 * Shared machinery for the Slack directory endpoints (the channel picker and
 * the mention picker):
 *
 *   - `pageSlackList` — cursor-pagination with a records ceiling high enough
 *     for large orgs (~9.6k), a wall-clock deadline (Vercel maxDuration is
 *     15s), and one short rate-limit retry. It never throws for size reasons:
 *     when a limit is hit it returns what it has with `truncated: true`, so
 *     the UI can say "list may be incomplete" instead of silently missing
 *     entries (the bug this replaced: a 1,000-record cap that made existing
 *     channels/people unfindable in big workspaces).
 *   - `readDirectoryCache` / `writeDirectoryCache` — short-TTL per-workspace
 *     cache of the final response payloads (migration 005). Errors — including
 *     a not-yet-migrated table — degrade to a cache miss, never a failure.
 *   - `normalizeMembers` — pure users.list → picker-shape mapping, exported
 *     for unit tests.
 */

import supabase from "./supabase.js";
import { fetchWithTimeout } from "./http.js";
import { logger } from "./logger.js";
import { UpstreamError, ValidationError } from "./errors.js";

// Slack documents conversations.list `limit` as an integer under 1000 and
// users.list as at most 1000; 800 keeps both comfortably valid.
export const PAGE_LIMIT = 800;
export const MAX_PAGES = 12; // ceiling ≈ 9,600 raw records per directory
const DEADLINE_MS = 9_500; // leave headroom under Vercel's 15s maxDuration
const RATE_RETRY_MAX_S = 3; // honor Retry-After once, only if it's short

/** Slack errors that mean the bot token can't be used — reconnect Slack. */
export const SLACK_AUTH_ERRORS = new Set([
  "token_revoked",
  "invalid_auth",
  "account_inactive",
  "missing_scope",
]);

export const DIRECTORY_CACHE_TTL_MS = 10 * 60 * 1000;

/** @param {number} ms */
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Is a cache row still fresh? Pure, exported for tests.
 *
 * @param {string | null | undefined} fetchedAt ISO timestamp
 * @param {number} nowMs
 * @param {number} [ttlMs]
 */
export function cacheFresh(fetchedAt, nowMs, ttlMs = DIRECTORY_CACHE_TTL_MS) {
  if (typeof fetchedAt !== "string") return false;
  const t = new Date(fetchedAt).getTime();
  return Number.isFinite(t) && nowMs - t < ttlMs;
}

/**
 * Page through a Slack list method, collecting raw records.
 *
 * @param {string} botToken
 * @param {string} method  e.g. "conversations.list"
 * @param {Record<string, string>} params  extra query params (limit/cursor added here)
 * @param {string} listField  response field holding the page's records, e.g. "channels"
 * @returns {Promise<{ records: any[], truncated: boolean }>}
 */
export async function pageSlackList(botToken, method, params, listField) {
  /** @type {any[]} */
  const records = [];
  let cursor = "";
  let retriedRateLimit = false;
  const startedAt = Date.now();

  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() - startedAt > DEADLINE_MS) {
      logger.warn("slack_list_deadline", { method, pages: page });
      return { records, truncated: true };
    }

    const url = new URL(`https://slack.com/api/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    const r = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      timeoutMs: 8_000,
    });

    // HTTP 429: retry once if Retry-After is short, else return partial.
    if (r.status === 429) {
      const retryAfter = Number(r.headers.get("retry-after") ?? NaN);
      if (!retriedRateLimit && Number.isFinite(retryAfter) && retryAfter <= RATE_RETRY_MAX_S) {
        retriedRateLimit = true;
        await sleep(retryAfter * 1000);
        page--; // redo this page
        continue;
      }
      logger.warn("slack_list_rate_limited", { method, pages: page });
      return { records, truncated: true };
    }

    /** @type {any} */
    const data = await r.json();
    if (!data.ok) {
      if (data.error === "ratelimited") {
        logger.warn("slack_list_rate_limited", { method, pages: page });
        return { records, truncated: true };
      }
      logger.warn("slack_list_failed", { method, error: data.error });
      if (typeof data.error === "string" && SLACK_AUTH_ERRORS.has(data.error)) {
        throw new ValidationError("slack_reauth_required");
      }
      throw new UpstreamError(`slack_error:${String(data.error).slice(0, 60)}`);
    }

    if (Array.isArray(data[listField])) records.push(...data[listField]);
    cursor = data.response_metadata?.next_cursor || "";
    if (!cursor) return { records, truncated: false };
  }

  // Ran out of page budget with a cursor still pending.
  logger.warn("slack_list_page_cap", { method, records: records.length });
  return { records, truncated: true };
}

/**
 * Map raw users.list members to the picker shape: humans only, with BOTH the
 * display name and the real name so search can match either (a person whose
 * display name is "PJ" must still be findable as "Piyush Jain").
 *
 * @param {any[]} members
 * @returns {Array<{ id: string, name: string, real_name: string }>}
 */
export function normalizeMembers(members) {
  /** @type {Array<{ id: string, name: string, real_name: string }>} */
  const out = [];
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m.id !== "string") continue;
    if (m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
    const display = m.profile?.display_name || m.profile?.real_name || m.real_name || m.name;
    if (typeof display !== "string" || !display) continue;
    const real = m.profile?.real_name || m.real_name || "";
    out.push({ id: m.id, name: display, real_name: real === display ? "" : real });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Read a fresh cache row, or null. Any error (including a not-yet-migrated
 * table) is a cache miss.
 *
 * @param {string} teamId
 * @param {"channels" | "mentions"} kind
 * @returns {Promise<{ payload: any, truncated: boolean } | null>}
 */
export async function readDirectoryCache(teamId, kind) {
  try {
    const { data, error } = await supabase
      .from("slack_directory_cache")
      .select("payload, truncated, fetched_at")
      .eq("slack_team_id", teamId)
      .eq("kind", kind)
      .maybeSingle();
    if (error || !data) return null;
    if (!cacheFresh(data.fetched_at, Date.now())) return null;
    return { payload: data.payload, truncated: !!data.truncated };
  } catch {
    return null;
  }
}

/**
 * Best-effort cache write; failures only log.
 *
 * @param {string} teamId
 * @param {"channels" | "mentions"} kind
 * @param {any} payload
 * @param {boolean} truncated
 */
export async function writeDirectoryCache(teamId, kind, payload, truncated) {
  try {
    const { error } = await supabase.from("slack_directory_cache").upsert(
      {
        slack_team_id: teamId,
        kind,
        payload,
        truncated,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "slack_team_id,kind" },
    );
    if (error) logger.warn("directory_cache_write_failed", { kind, err: error });
  } catch (err) {
    logger.warn("directory_cache_write_failed", {
      kind,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
