-- ============================================================
-- Migration 006 — email as an alternative notification destination
-- ============================================================
-- Run once in the Supabase SQL editor. Safe to re-run (fully idempotent).
--
-- A file's config now targets ONE destination: Slack (as before) or email.
--   * destination        — 'slack' | 'email'. Existing rows default to
--                          'slack', so nothing changes for current users.
--   * slack_team_id      — now nullable: an email config has no workspace.
--   * email_recipients   — JSONB array of up to 5 addresses with their
--                          double-opt-in state:
--                          [{ "email": "a@b.com",
--                             "status": "pending" | "confirmed" | "unsubscribed",
--                             "added_at": ts, "confirmed_at": ts | null }]
--                          Only "confirmed" addresses are ever emailed.
--   * email_timezone     — IANA zone captured from the editor who saved the
--                          list; emails show the publish time in it.
--   * notification_log.recipient — the address a row was sent to, so a Figma
--                          retry re-drives only the recipients that didn't
--                          get the email (mirrors slack_channel_id).
--
-- Expand-only: the currently-deployed backend ignores the new columns and
-- keeps writing Slack rows, so this can run before the deploy.

ALTER TABLE configurations ADD COLUMN IF NOT EXISTS destination TEXT NOT NULL DEFAULT 'slack';
ALTER TABLE configurations ALTER COLUMN slack_team_id DROP NOT NULL;
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS email_recipients JSONB NOT NULL DEFAULT '[]';
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS email_timezone TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'configurations_destination_check'
  ) THEN
    ALTER TABLE configurations
      ADD CONSTRAINT configurations_destination_check
      CHECK (destination IN ('slack', 'email'));
  END IF;

  -- A Slack config must still name its workspace; an email config has none.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'configurations_destination_target_check'
  ) THEN
    ALTER TABLE configurations
      ADD CONSTRAINT configurations_destination_target_check
      CHECK (destination <> 'slack' OR slack_team_id IS NOT NULL);
  END IF;
END $$;

ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS recipient TEXT;
CREATE INDEX IF NOT EXISTS idx_log_event_dedupe_email
  ON notification_log(event_key, configuration_id, recipient);
