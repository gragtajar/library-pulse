// @ts-check
/**
 * Figma OAuth scope constants + pure decision helpers.
 *
 * Kept free of I/O (no supabase/fetch imports) so it's trivially unit-testable
 * and safe to import from anywhere. The side-effecting file access probe lives
 * in `figma-access.js`, which imports the pure helpers here.
 */

/**
 * The Figma OAuth scopes Library Pulse requests, defined once so the authorize
 * URL (`api/auth/figma.js`) and the stored token record
 * (`api/auth/figma-callback.js`) can never drift apart.
 *
 * - `webhooks:write` — create/delete the `LIBRARY_PUBLISH` webhook on the file
 *   the user selects.
 * - `webhooks:read` — list the webhooks registered on a file to confirm the
 *   caller can access that file before returning or mutating its shared config
 *   (see `figma-access.js`). Added in Batch 2.
 *
 * IMPORTANT: Figma's OAuth `scope` param is SPACE-delimited (OAuth2 spec). A
 * comma-joined value is parsed as a single invalid scope ("Invalid scopes for
 * app"), so this MUST stay space-separated.
 */
export const FIGMA_OAUTH_SCOPES = "webhooks:write webhooks:read";

/**
 * Does a stored (space-delimited) scope string grant `scope`?
 *
 * @param {string|null|undefined} granted
 * @param {string} scope
 * @returns {boolean}
 */
export function scopeGranted(granted, scope) {
  if (typeof granted !== "string") return false;
  return granted.split(/\s+/).filter(Boolean).includes(scope);
}

/**
 * Pure decision table for the file-access probe, exported so the mapping can be
 * unit-tested without mocking supabase/fetch.
 *
 *   - no `webhooks:read` on the token → the token predates Batch 2; the user
 *     must reconnect Figma to grant it → `"reauth"`.
 *   - 2xx → the caller can access the file → `"ok"`.
 *   - 401 → token invalid/revoked → `"reauth"`.
 *   - 403 → the caller cannot access the file → `"forbidden"`.
 *   - anything else → transient upstream problem → `"error"`.
 *
 * @param {{ hasReadScope: boolean, ok: boolean, status: number }} p
 * @returns {"ok"|"reauth"|"forbidden"|"error"}
 */
export function classifyAccess({ hasReadScope, ok, status }) {
  if (!hasReadScope) return "reauth";
  if (ok) return "ok";
  if (status === 401) return "reauth";
  if (status === 403) return "forbidden";
  return "error";
}
