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
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────
-- 3. Registered Figma webhooks (one per team)
-- ────────────────────────────────────────────────
CREATE TABLE figma_webhooks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  figma_team_id   TEXT NOT NULL UNIQUE,
  webhook_id      TEXT NOT NULL,
  passcode        TEXT NOT NULL,
  registered_by   TEXT,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','paused','failed')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_webhooks_webhook_id ON figma_webhooks(webhook_id);

-- ────────────────────────────────────────────────
-- 4. Core config: file → Slack channel mapping
-- ────────────────────────────────────────────────
CREATE TABLE configurations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  figma_user_id   TEXT NOT NULL,
  figma_team_id   TEXT NOT NULL,
  figma_file_key  TEXT NOT NULL,
  figma_file_name TEXT,
  slack_team_id   TEXT NOT NULL REFERENCES slack_installations(slack_team_id) ON DELETE CASCADE,
  channels        JSONB NOT NULL DEFAULT '[]',
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(figma_user_id, figma_file_key)
);

-- ────────────────────────────────────────────────
-- 5. OAuth flow sessions
-- ────────────────────────────────────────────────
CREATE TABLE auth_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  state           TEXT NOT NULL UNIQUE,
  provider        TEXT NOT NULL CHECK (provider IN ('slack','figma')),
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
  slack_channel_id  TEXT,
  status            TEXT CHECK (status IN ('sent','failed')),
  error_message     TEXT,
  payload_summary   JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────
-- 7. Webhook idempotency — dedupe Figma's retries
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

-- The backend connects with the service_role key → full access.
CREATE POLICY srv_all ON slack_installations FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON figma_tokens        FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON figma_webhooks      FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON configurations      FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON auth_sessions       FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON notification_log    FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY srv_all ON webhook_events      FOR ALL USING (TRUE) WITH CHECK (TRUE);

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
