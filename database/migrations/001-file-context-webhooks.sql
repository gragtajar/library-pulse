-- ============================================================
-- Migration 001 — file-context webhooks + per-channel dedupe
-- ============================================================
-- Run once in the Supabase SQL editor on an existing install.
-- Safe to re-run: every statement is idempotent.
--
-- What changed and why:
--  * Webhooks are now registered per (user, file) using the user's own Figma
--    OAuth token, instead of one team-context webhook via a shared admin PAT.
--    So `figma_webhooks` gains context columns and is keyed by (user, file).
--  * `configurations.figma_team_id` is no longer collected, so it becomes
--    nullable.
--  * `notification_log` gains `event_key` so webhook delivery can be deduped
--    at channel granularity (retry-safe fan-out).

-- ── figma_webhooks: team-context → file-context ──
ALTER TABLE figma_webhooks ADD COLUMN IF NOT EXISTS context       TEXT;
ALTER TABLE figma_webhooks ADD COLUMN IF NOT EXISTS context_id    TEXT;
ALTER TABLE figma_webhooks ADD COLUMN IF NOT EXISTS figma_user_id TEXT;
ALTER TABLE figma_webhooks ALTER COLUMN figma_team_id DROP NOT NULL;

-- The old one-webhook-per-team unique constraint no longer applies.
ALTER TABLE figma_webhooks DROP CONSTRAINT IF EXISTS figma_webhooks_figma_team_id_key;

-- One webhook per (user, file). A unique index works for ON CONFLICT upserts
-- and supports IF NOT EXISTS (a named constraint does not).
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhooks_user_context
  ON figma_webhooks(figma_user_id, context_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_context_id
  ON figma_webhooks(context_id);

-- ── configurations: team id no longer required ──
ALTER TABLE configurations ALTER COLUMN figma_team_id DROP NOT NULL;

-- ── notification_log: per-channel dedupe key ──
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS event_key TEXT;
CREATE INDEX IF NOT EXISTS idx_log_event_dedupe
  ON notification_log(event_key, configuration_id, slack_channel_id);

-- Optional cleanup: legacy team-context webhook rows (context IS NULL) are no
-- longer used by the handler. Leave them or remove them:
-- DELETE FROM figma_webhooks WHERE context IS NULL;
