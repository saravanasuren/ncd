-- 011_lockerhub_outbound — Wealth→LockerHub push channel (ported from the old
-- app's agent_event_webhooks). Dispatch is gated on LOCKERHUB_WEBHOOK_URL +
-- LOCKERHUB_WEBHOOK_SECRET in SSM — absent (the default) nothing enqueues or fires.

-- LockerHub's user id for agents sourced from the DhanamFin app — lets the
-- webhook payload route to the right mobile installation without a lookup
-- on their side.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS lockerhub_user_id BIGINT;

CREATE TABLE IF NOT EXISTS agent_event_webhooks (
  id                    BIGSERIAL PRIMARY KEY,
  event_type            TEXT NOT NULL,          -- customer_activated|incentive_accrued|incentive_paid
  target_agent_id       BIGINT NOT NULL REFERENCES agents(id),
  lockerhub_user_id     BIGINT NOT NULL,
  dedup_key             TEXT UNIQUE NOT NULL,
  payload               JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed|abandoned
  attempts              INT NOT NULL DEFAULT 0,
  max_attempts          INT NOT NULL DEFAULT 6,
  next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at       TIMESTAMPTZ,
  sent_at               TIMESTAMPTZ,
  http_response_status  INT,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_events_pending
  ON agent_event_webhooks (next_attempt_at) WHERE status = 'pending';
