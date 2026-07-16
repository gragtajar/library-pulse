-- ============================================================
-- Migration 003 — org-shared, per-file configuration
-- ============================================================
-- Run once in the Supabase SQL editor. Safe to re-run (fully idempotent).
--
-- What changes and why (SPEC-batch-2 §3a):
--   Configuration becomes keyed by FILE, not by user: anyone with edit access
--   to a file manages that file's single shared config. So:
--     * configurations: de-dupe to one row per file, add created_by (original
--       setter), add delivery_status/last_delivery_error (revocation surfacing),
--       and add UNIQUE(figma_file_key).
--     * figma_webhooks: de-dupe to one row per file, add UNIQUE(context_id).
--     * figma_tokens: add scopes (so the backend knows whether a token carries
--       webhooks:read before it tries the file-access probe).
--
-- ⚠️ ROLLOUT — EXPAND/CONTRACT. This migration is deliberately "expand only":
-- it ADDS the new UNIQUE(figma_file_key)/UNIQUE(context_id) but KEEPS the old
-- UNIQUE(figma_user_id, …) constraints, so the currently-deployed backend keeps
-- working after you run it. Once the new backend is deployed AND the old plugin
-- is retired, run the companion contract step at the bottom (commented out) to
-- drop the now-redundant per-user constraints.
--
-- ⚠️ DATA CHANGE. The de-dupe DELETEs keep the OLDEST config/webhook per file
-- and remove the rest. If two users independently configured the same file with
-- different channels, the newer one is discarded. Snapshot the tables first.

BEGIN;

-- ── configurations: de-dupe to one row per file (keep oldest) ──
DELETE FROM configurations c
USING configurations keep
WHERE c.figma_file_key = keep.figma_file_key
  AND (
    keep.created_at < c.created_at
    OR (keep.created_at = c.created_at AND keep.id < c.id)
  );

-- ── configurations: new columns ──
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS created_by TEXT;
UPDATE configurations SET created_by = figma_user_id WHERE created_by IS NULL;

ALTER TABLE configurations ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS last_delivery_error TEXT;

-- Constrain delivery_status to the known set (idempotent add).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'configurations_delivery_status_check'
  ) THEN
    ALTER TABLE configurations
      ADD CONSTRAINT configurations_delivery_status_check
      CHECK (delivery_status IN ('ok', 'slack_revoked', 'figma_revoked', 'send_failing'));
  END IF;
END $$;

-- ── configurations: one config per file (kept alongside the old per-user one) ──
CREATE UNIQUE INDEX IF NOT EXISTS uq_configs_file_key ON configurations(figma_file_key);

-- ── figma_webhooks: de-dupe to one row per file context (keep oldest) ──
DELETE FROM figma_webhooks w
USING figma_webhooks keep
WHERE w.context_id IS NOT NULL
  AND w.context_id = keep.context_id
  AND (
    keep.created_at < w.created_at
    OR (keep.created_at = w.created_at AND keep.id < w.id)
  );

-- ── figma_webhooks: one webhook per file (NULLs stay distinct → legacy rows ok) ──
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhooks_context ON figma_webhooks(context_id);

-- ── figma_tokens: remember the granted scopes ──
ALTER TABLE figma_tokens ADD COLUMN IF NOT EXISTS scopes TEXT;
-- Existing tokens were minted before webhooks:read; record that truthfully so
-- the access probe asks these users to reconnect instead of misfiring.
UPDATE figma_tokens SET scopes = 'webhooks:write' WHERE scopes IS NULL;

COMMIT;

-- ============================================================
-- CONTRACT STEP — run ONLY after the new backend is deployed and the old
-- plugin build is fully retired. Dropping these while the old backend is still
-- live would break its config/webhook upserts (their ON CONFLICT targets these
-- constraints). Left commented on purpose.
-- ============================================================
-- ALTER TABLE configurations DROP CONSTRAINT IF EXISTS configurations_figma_user_id_figma_file_key_key;
-- DROP INDEX IF EXISTS uq_webhooks_user_context;
