-- ============================================================
-- Migration 002 — auth_sessions.used_at (+ webhook_events safety net)
-- ============================================================
-- Run once in the Supabase SQL editor. Safe to re-run (fully idempotent).
--
-- Why this exists (the "Could not create auth session" bug):
--   The OAuth-initiate endpoints (/api/auth/figma, /api/auth/slack) and the
--   callbacks read/write `auth_sessions.used_at` (single-use replay
--   protection). That column was added to schema.sql for fresh installs but
--   was never shipped as a migration, so any database provisioned from an
--   earlier schema is missing it — and every session upsert fails with
--   "column auth_sessions.used_at does not exist", surfaced to the plugin as
--   "Could not create auth session".
--
-- This migration adds the column on existing installs and, defensively,
-- ensures the webhook_events dedupe table exists (also schema.sql-only).

-- ── auth_sessions: single-use marker ──
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

-- ── webhook_events: idempotency table (present in schema.sql; ensure on old DBs) ──
CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_key       TEXT NOT NULL UNIQUE,
  event_type      TEXT,
  figma_file_key  TEXT,
  received_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at);

-- RLS parity with the rest of the schema (service role bypasses; enable anyway).
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'webhook_events' AND policyname = 'srv_all'
  ) THEN
    CREATE POLICY srv_all ON webhook_events FOR ALL USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;
