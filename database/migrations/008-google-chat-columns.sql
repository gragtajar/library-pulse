-- ============================================================
-- Migration 008 — the two Google Chat columns migration 007 gained late
-- ============================================================
-- Run once in the Supabase SQL editor. Safe to re-run (fully idempotent).
--
-- Migration 007 was handed out for running before these two columns were
-- added to it, so databases that ran that earlier copy lack them, and every
-- save that names them fails with PGRST204 ("Could not find the
-- 'gchat_timezone' column of 'configurations' in the schema cache"):
--
--   * configurations.gchat_timezone — IANA zone of the editor who saved a
--                                     file's Google Chat spaces; posts show
--                                     the publish time in it.
--   * gchat_spaces.muted            — "@Library Pulse stop" in a space pauses
--                                     its updates until "start".
--
-- A database that ran the final 007 already has both; then this changes
-- nothing. Expand-only.

ALTER TABLE configurations ADD COLUMN IF NOT EXISTS gchat_timezone TEXT;
ALTER TABLE gchat_spaces   ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT FALSE;

-- PostgREST (the Supabase Data API) answers from a cached copy of the schema;
-- ask it to reload now rather than whenever it next notices.
-- docs.postgrest.org/en/stable/references/schema_cache.html
NOTIFY pgrst, 'reload schema';

-- Check (should return both rows):
--   SELECT table_name, column_name FROM information_schema.columns
--   WHERE (table_name, column_name) IN
--         (('configurations', 'gchat_timezone'), ('gchat_spaces', 'muted'));
