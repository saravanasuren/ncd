-- 004_portal_integration — notifications, portal OTP, service requests,
-- outbound webhooks (docs/02 §ops, docs/08). Idempotent; Postgres + PGlite.

CREATE TABLE IF NOT EXISTS notifications_queue (
  id                  BIGSERIAL PRIMARY KEY,
  channel             TEXT NOT NULL,          -- email|sms|whatsapp
  template            TEXT NOT NULL,
  to_address          TEXT NOT NULL,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'Pending', -- Pending|Sent|Failed
  provider_message_id TEXT,
  attempts            INT NOT NULL DEFAULT 0,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications_queue(status);

CREATE TABLE IF NOT EXISTS customer_otp_sessions (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  otp_hash     TEXT NOT NULL,
  channel      TEXT NOT NULL,
  destination  TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_customer ON customer_otp_sessions(customer_id);

CREATE TABLE IF NOT EXISTS portal_service_requests (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  details       TEXT,
  status        TEXT NOT NULL DEFAULT 'Open',  -- Open|InProgress|Resolved|Rejected
  source        TEXT NOT NULL DEFAULT 'portal', -- portal|lockerhub
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_psr_customer ON portal_service_requests(customer_id);

-- Outbound events to LockerHub (drained by a cron in production).
CREATE TABLE IF NOT EXISTS agent_event_webhooks (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Pending',
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at  TIMESTAMPTZ
);
