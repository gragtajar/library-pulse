-- ============================================================
-- Library Pulse — Supabase / PostgreSQL Schema
-- ============================================================
-- See database/migrations/ for an incremental migration history.
-- This file is the canonical full schema for a fresh install.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ────────────────────────────────────────────────
-- 1. Slack workspace installations
-- ────────────────────────────────────────────────
CREATE TABLE slack_installations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slack_team_id   TEXT NOT NULL UNIQUE,
  slack_team_name TEXT,
  bot_token_enc   TEXT NOT NULL,             -- AES-256-GCM encrypted
  bot_user_id     TEXT,
  installing_user TEXT,
  scopes          TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────
-- 2. Figma user OAuth tokens
-- ────────────────────────────────────────────────
CREATE TABLE figma_tokens (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  figma_user_id     TEXT NOT NULL UNIQUE,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at        TIMESTAMPTZ,
  scopes            TEXT,                       -- granted OAuth scopes (space-delimited)
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────
-- 3. Registered Figma webhooks (file context, one per file)
-- ────────────────────────────────────────────────
-- Webhooks are registered on the "file" context with the original setter's own
-- Figma OAuth token. The config is org-shared, so there is exactly ONE webhook
-- per file (registered_by records who set it up). `figma_team_id` is kept only
-- for backward compatibility with any legacy team-context rows.
CREATE TABLE figma_webhooks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  figma_user_id   TEXT,
  context         TEXT,                       -- 'file' (legacy rows may be NULL)
  context_id      TEXT,                       -- the Figma file key for file context
  figma_team_id   TEXT,                       -- legacy / unused for file context
  webhook_id      TEXT NOT NULL,
  passcode        TEXT NOT NULL,
  registered_by   TEXT,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','paused','failed')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_webhooks_webhook_id ON figma_webhooks(webhook_id);
CREATE UNIQUE INDEX uq_webhooks_context ON figma_webhooks(context_id);

-- ────────────────────────────────────────────────
-- 3b. Google accounts that connected Google Chat (migration 007)
-- ────────────────────────────────────────────────
-- One row per Google account that signed in from the plugin: its stable id
-- ("sub"), email and Workspace domain ("hd"), who connected it, and its OAuth
-- refresh token. The token is used only to list the account's spaces and to
-- add the Library Pulse app to the chosen ones; updates are posted as the app.
CREATE TABLE google_installations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  google_sub        TEXT NOT NULL UNIQUE,
  google_email      TEXT,
  google_hd         TEXT,                         -- NULL for consumer accounts
  figma_user_id     TEXT,                         -- who connected it
  refresh_token_enc TEXT NOT NULL,                -- AES-256-GCM encrypted
  scopes            TEXT,                         -- granted OAuth scopes (space-delimited)
  revoked_at        TIMESTAMPTZ,                  -- set when Google rejects the refresh token
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────
-- 4. Core config: file → destination (Slack channels, email addresses or
--    Google Chat spaces)
-- ────────────────────────────────────────────────
-- Org-shared: keyed by FILE, not user. One config per file; anyone with edit
-- access to the file manages it. `created_by` is the original setter (only they
-- can tear down the Figma webhook). `figma_user_id` is retained (= created_by).
-- A config targets exactly ONE destination (migrations 006, 007): 'slack' uses
-- slack_team_id + channels; 'email' uses email_recipients + email_timezone;
-- 'gchat' uses google_installation_id + gchat_spaces + gchat_timezone.
CREATE TABLE configurations (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  figma_user_id       TEXT NOT NULL,
  created_by          TEXT,                        -- original setter's Figma user id
  figma_team_id       TEXT,                        -- unused for file-context webhooks
  figma_file_key      TEXT NOT NULL,
  figma_file_name     TEXT,
  destination         TEXT NOT NULL DEFAULT 'slack',
  slack_team_id       TEXT REFERENCES slack_installations(slack_team_id) ON DELETE CASCADE,
  channels            JSONB NOT NULL DEFAULT '[]',
  -- Email destination: up to 5 addresses with double-opt-in state
  -- [{email, status: 'pending'|'confirmed'|'unsubscribed', added_at, confirmed_at}];
  -- only 'confirmed' addresses are ever emailed. The timezone is the IANA zone
  -- of the editor who saved the list (publish times are rendered in it).
  email_recipients    JSONB NOT NULL DEFAULT '[]',
  email_timezone      TEXT,
  -- Google Chat destination: the account whose token adds the app to spaces,
  -- up to 3 spaces [{name: 'spaces/…', display_name}], and the IANA zone of
  -- the editor who saved them (posts show the publish time in it).
  google_installation_id UUID REFERENCES google_installations(id) ON DELETE SET NULL,
  gchat_spaces        JSONB NOT NULL DEFAULT '[]',
  gchat_timezone      TEXT,
  custom_message      TEXT,                        -- optional team note appended to every notification
  custom_mentions     JSONB NOT NULL DEFAULT '[]', -- validated picker mentions [{id,type,label}]
  is_active           BOOLEAN DEFAULT TRUE,
  delivery_status     TEXT NOT NULL DEFAULT 'ok',
  last_delivery_error TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(figma_file_key),
  -- Named as the migrations name them, so 006–008 re-run cleanly here.
  CONSTRAINT configurations_destination_check
    CHECK (destination IN ('slack', 'email', 'gchat')),
  CONSTRAINT configurations_delivery_status_check
    CHECK (delivery_status IN ('ok', 'slack_revoked', 'figma_revoked', 'google_revoked', 'send_failing')),
  -- A Slack config names its workspace; a Google Chat config names the Google
  -- account whose token manages its spaces; an email config has neither.
  CONSTRAINT configurations_destination_target_check
    CHECK (
      (destination <> 'slack' OR slack_team_id IS NOT NULL)
      AND (destination <> 'gchat' OR google_installation_id IS NOT NULL)
    )
);

-- ────────────────────────────────────────────────
-- 5. OAuth flow sessions
-- ────────────────────────────────────────────────
CREATE TABLE auth_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  state           TEXT NOT NULL UNIQUE,
  provider        TEXT NOT NULL
                    CONSTRAINT auth_sessions_provider_check
                    CHECK (provider IN ('slack', 'figma', 'google')),
  figma_user_id   TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','expired')),
  result_data     JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '10 minutes',
  used_at         TIMESTAMPTZ                            -- non-null once the session has been consumed by a callback
);

-- ────────────────────────────────────────────────
-- 6. Notification audit log
-- ────────────────────────────────────────────────
CREATE TABLE notification_log (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  configuration_id  UUID REFERENCES configurations(id) ON DELETE SET NULL,
  figma_file_key    TEXT,
  event_type        TEXT,
  event_key         TEXT,                      -- per-target webhook dedupe key
  slack_channel_id  TEXT,                      -- Slack deliveries
  recipient         TEXT,                      -- email address or Google Chat space ("spaces/…")
  status            TEXT CHECK (status IN ('sent','failed')),
  error_message     TEXT,
  payload_summary   JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_log_event_dedupe ON notification_log(event_key, configuration_id, slack_channel_id);
CREATE INDEX idx_log_event_dedupe_email ON notification_log(event_key, configuration_id, recipient);

-- ────────────────────────────────────────────────
-- 7. Per-workspace Slack directory cache (channel + mention pickers)
-- ────────────────────────────────────────────────
-- Short-TTL cache of the pickers' final response payloads, so large
-- workspaces don't re-page conversations.list / users.list on every open.
CREATE TABLE slack_directory_cache (
  slack_team_id  TEXT NOT NULL REFERENCES slack_installations(slack_team_id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('channels', 'mentions')),
  payload        JSONB NOT NULL,
  truncated      BOOLEAN NOT NULL DEFAULT FALSE,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slack_team_id, kind)
);

-- ────────────────────────────────────────────────
-- 7b. Google Chat spaces the app has been added to (migrations 007, 008)
-- ────────────────────────────────────────────────
-- Kept current from Chat's ADDED_TO_SPACE / REMOVED_FROM_SPACE events, so a
-- publish skips a space the app was removed from or that asked to stop.
CREATE TABLE gchat_spaces (
  space_name    TEXT PRIMARY KEY,                 -- "spaces/AAAA…"
  display_name  TEXT,
  space_type    TEXT,                             -- SPACE | GROUP_CHAT | DIRECT_MESSAGE
  app_member    BOOLEAN NOT NULL DEFAULT TRUE,    -- FALSE after REMOVED_FROM_SPACE
  added_by      TEXT,                             -- "users/…" who last added or removed the app
  added_at      TIMESTAMPTZ DEFAULT NOW(),
  removed_at    TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ DEFAULT NOW(),
  muted         BOOLEAN NOT NULL DEFAULT FALSE    -- "@Library Pulse stop" until "start"
);

-- ────────────────────────────────────────────────
-- 8. Webhook idempotency — dedupe Figma's retries
-- ────────────────────────────────────────────────
CREATE TABLE webhook_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_key       TEXT NOT NULL UNIQUE,        -- "figma:<event_id>" or "figma:hash:<sha256>"
  event_type      TEXT,
  figma_file_key  TEXT,
  received_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_webhook_events_received ON webhook_events(received_at);

-- ────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────
CREATE INDEX idx_configs_file_key   ON configurations(figma_file_key);
CREATE INDEX idx_configs_user       ON configurations(figma_user_id);
CREATE INDEX idx_configs_active     ON configurations(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_configs_google_installation ON configurations(google_installation_id);
CREATE INDEX idx_auth_state         ON auth_sessions(state);
CREATE INDEX idx_log_config         ON notification_log(configuration_id);
CREATE INDEX idx_log_created        ON notification_log(created_at);

-- ────────────────────────────────────────────────
-- Auto-update updated_at
-- ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON slack_installations
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON figma_tokens
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON configurations
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON google_installations
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ────────────────────────────────────────────────
-- Row-Level Security (service-role bypass)
-- ────────────────────────────────────────────────
ALTER TABLE slack_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE figma_tokens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE figma_webhooks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE configurations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_directory_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gchat_spaces        ENABLE ROW LEVEL SECURITY;

-- The backend connects with the service_role key → full access.
CREATE POLICY srv_all ON slack_installations FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON figma_tokens        FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON figma_webhooks      FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON configurations      FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON auth_sessions       FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON notification_log    FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON webhook_events      FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON slack_directory_cache FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON google_installations FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON gchat_spaces        FOR ALL USING (TRUE) WITH CHECK (TRUE);

-- ────────────────────────────────────────────────
-- Cron jobs (Supabase pg_cron). Uncomment after extension is enabled.
-- ────────────────────────────────────────────────
-- SELECT cron.schedule('expire-auth-sessions', '*/5 * * * *',
--   $$UPDATE auth_sessions
--     SET    status = 'expired'
--     WHERE  status = 'pending' AND expires_at < NOW()$$);
--
-- SELECT cron.schedule('gc-webhook-events', '0 3 * * *',
--   $$DELETE FROM webhook_events WHERE received_at < NOW() - INTERVAL '14 days'$$);
--
-- SELECT cron.schedule('gc-notification-log', '0 4 * * 0',
--   $$DELETE FROM notification_log WHERE created_at < NOW() - INTERVAL '90 days'$$);
