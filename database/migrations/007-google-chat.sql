-- ============================================================
-- Migration 007 — Google Chat as a notification destination
-- ============================================================
-- Run once in the Supabase SQL editor. Safe to re-run (fully idempotent).
--
-- A user connects Google Chat with a Google sign-in from the plugin (OAuth,
-- scopes chat.spaces.readonly + chat.memberships.app + openid email), picks the
-- spaces they belong to, and Library Pulse adds itself to those spaces on their
-- behalf. Publish updates are then posted by the Library Pulse app itself
-- (app authentication, scope chat.bot), never with the user's token.
--
--   * google_installations — one row per Google account that connected: the
--                            account's stable id, email and Workspace domain,
--                            and its OAuth refresh token (AES-256-GCM
--                            encrypted), mirroring slack_installations.
--   * gchat_spaces         — every space the app has been added to, kept
--                            current from Chat's ADDED_TO_SPACE /
--                            REMOVED_FROM_SPACE events, so the plugin can say
--                            when the app was removed from a space.
--   * configurations       — destination 'gchat' uses google_installation_id
--                            (whose token adds the app and lists spaces) and
--                            gchat_spaces: [{ "name": "spaces/…",
--                            "display_name": "…" }], up to 3, and
--                            gchat_timezone (the IANA zone of the editor who
--                            saved the spaces; the posted time is shown in it).
--   * delivery_status      — 'google_revoked' when Google rejects the stored
--                            refresh token (the user must reconnect).
--   * auth_sessions        — provider 'google' for the sign-in round trip.
--   * notification_log.recipient — reused for the space name a row was sent
--                            to (mirrors slack_channel_id / email recipient).
--
-- Expand-only: the currently-deployed backend ignores the new columns and
-- tables, so this can run before the deploy.

CREATE TABLE IF NOT EXISTS google_installations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  google_sub        TEXT NOT NULL UNIQUE,          -- the account's stable id ("sub" claim)
  google_email      TEXT,
  google_hd         TEXT,                         -- Workspace domain ("hd" claim); NULL for consumer accounts
  figma_user_id     TEXT,                         -- who connected it
  refresh_token_enc TEXT NOT NULL,                -- AES-256-GCM encrypted
  scopes            TEXT,                         -- granted OAuth scopes (space-delimited)
  revoked_at        TIMESTAMPTZ,                  -- set when Google rejects the refresh token
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gchat_spaces (
  space_name    TEXT PRIMARY KEY,                 -- "spaces/AAAA…" as Chat names it
  display_name  TEXT,
  space_type    TEXT,                             -- SPACE | GROUP_CHAT | DIRECT_MESSAGE
  app_member    BOOLEAN NOT NULL DEFAULT TRUE,    -- FALSE after REMOVED_FROM_SPACE
  added_by      TEXT,                             -- "users/…" of whoever added the app
  added_at      TIMESTAMPTZ DEFAULT NOW(),
  removed_at    TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE configurations
  ADD COLUMN IF NOT EXISTS google_installation_id UUID
    REFERENCES google_installations(id) ON DELETE SET NULL;
ALTER TABLE configurations
  ADD COLUMN IF NOT EXISTS gchat_spaces JSONB NOT NULL DEFAULT '[]';
ALTER TABLE configurations ADD COLUMN IF NOT EXISTS gchat_timezone TEXT;
-- "@Library Pulse stop" in a space pauses its updates until "start".
ALTER TABLE gchat_spaces ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  -- destination: 'slack' | 'email' | 'gchat'
  ALTER TABLE configurations DROP CONSTRAINT IF EXISTS configurations_destination_check;
  ALTER TABLE configurations
    ADD CONSTRAINT configurations_destination_check
    CHECK (destination IN ('slack', 'email', 'gchat'));

  -- A Slack config names its workspace; a Google Chat config names the
  -- Google account whose token manages its spaces; an email config has neither.
  ALTER TABLE configurations DROP CONSTRAINT IF EXISTS configurations_destination_target_check;
  ALTER TABLE configurations
    ADD CONSTRAINT configurations_destination_target_check
    CHECK (
      (destination <> 'slack' OR slack_team_id IS NOT NULL)
      AND (destination <> 'gchat' OR google_installation_id IS NOT NULL)
    );

  -- delivery_status gains 'google_revoked'
  ALTER TABLE configurations DROP CONSTRAINT IF EXISTS configurations_delivery_status_check;
  ALTER TABLE configurations
    ADD CONSTRAINT configurations_delivery_status_check
    CHECK (delivery_status IN ('ok', 'slack_revoked', 'figma_revoked', 'google_revoked', 'send_failing'));

  -- auth_sessions.provider gains 'google'. The original schema declared this
  -- check inline, so Postgres named it; drop whichever check mentions the
  -- column, then add the named one.
  DECLARE
    con RECORD;
  BEGIN
    FOR con IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'auth_sessions'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%provider%'
    LOOP
      EXECUTE format('ALTER TABLE auth_sessions DROP CONSTRAINT %I', con.conname);
    END LOOP;
  END;
  ALTER TABLE auth_sessions
    ADD CONSTRAINT auth_sessions_provider_check
    CHECK (provider IN ('slack', 'figma', 'google'));
END $$;

CREATE INDEX IF NOT EXISTS idx_configs_google_installation
  ON configurations(google_installation_id);

-- Row-Level Security, as for every other table: the backend uses the
-- service-role key, so the policy is "all".
ALTER TABLE google_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gchat_spaces         ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'google_installations' AND policyname = 'srv_all'
  ) THEN
    CREATE POLICY srv_all ON google_installations FOR ALL USING (TRUE) WITH CHECK (TRUE);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'gchat_spaces' AND policyname = 'srv_all'
  ) THEN
    CREATE POLICY srv_all ON gchat_spaces FOR ALL USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;

-- updated_at upkeep, as on the other mutable tables.
DROP TRIGGER IF EXISTS set_updated_at ON google_installations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON google_installations
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
