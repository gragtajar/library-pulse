-- ============================================================
-- Migration 004 — per-file custom message with @-mentions
-- ============================================================
-- Run once in the Supabase SQL editor. Safe to re-run (fully idempotent).
--
-- Adds an optional, team-editable note that is appended to every Slack
-- notification for the file:
--   * custom_message  — plain text as typed in the plugin (mention labels like
--     "@design-team" appear as human-readable text; NO Slack tokens stored).
--   * custom_mentions — JSONB array of validated picker-chosen mentions:
--     [{ "id": "U…|S…", "type": "user"|"usergroup", "label": "Display Name" }].
--     At delivery the backend escapes the text, then swaps each "@label" for
--     the real Slack token (<@U…> / <!subteam^S…>) — free text can never ping.
--
-- Expand-only: the currently-deployed backend ignores these columns, so this
-- can run before or after the deploy (before re-publishing the plugin is the
-- only hard requirement).

ALTER TABLE configurations ADD COLUMN IF NOT EXISTS custom_message TEXT;
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS custom_mentions JSONB NOT NULL DEFAULT '[]';
