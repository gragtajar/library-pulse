// @ts-check
/**
 * Pure helpers for the Slack channel picker (no I/O — unit-testable).
 */

/**
 * Normalize raw `conversations.list` channel objects to the picker shape and
 * sort by member count (most-populated first — the picker has no per-user
 * "most used" signal with these scopes, so member count is the ranking).
 *
 * @param {Array<any>} raw
 * @returns {Array<{id: string, name: string, is_private: boolean, num_members: number}>}
 */
export function normalizeChannels(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((c) => typeof c?.id === "string" && typeof c?.name === "string")
    .map((c) => ({
      id: c.id,
      name: c.name,
      is_private: !!c.is_private,
      num_members: typeof c.num_members === "number" ? c.num_members : 0,
    }))
    .sort((a, b) => b.num_members - a.num_members);
}
