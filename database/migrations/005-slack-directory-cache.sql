-- ============================================================
-- Migration 005 — per-workspace Slack directory cache
-- ============================================================
-- Run once in the Supabase SQL editor. Safe to re-run (fully idempotent).
--
-- Why: the channel picker and @-mention picker page through Slack's
-- conversations.list / users.list on every open. Large workspaces need many
-- pages (Tier-2 rate limits: ~20 req/min/workspace), so results are cached
-- per workspace for a short TTL. Rows hold the FINAL response payload the
-- endpoints serve (already filtered/normalized — no raw Slack records).
--
-- Deploy-order independent: the backend treats a missing table as a cache
-- miss, so this can run before or after the deploy.

CREATE TABLE IF NOT EXISTS slack_directory_cache (
  slack_team_id  TEXT NOT NULL REFERENCES slack_installations(slack_team_id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('channels', 'mentions')),
  payload        JSONB NOT NULL,
  truncated      BOOLEAN NOT NULL DEFAULT FALSE,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slack_team_id, kind)
);

-- RLS parity with the rest of the schema (service role bypasses; enable anyway).
ALTER TABLE slack_directory_cache ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'slack_directory_cache' AND policyname = 'srv_all'
  ) THEN
    CREATE POLICY srv_all ON slack_directory_cache FOR ALL USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;
