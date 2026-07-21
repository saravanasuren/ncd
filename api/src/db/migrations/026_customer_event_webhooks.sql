-- 026_customer_event_webhooks — NCD→LockerHub CUSTOMER/subscription event push
-- (NCD_INTEGRATION_CONTRACT.md v1.0 "Events the NCD app SENDS LockerHub").
--
-- Separate from agent_event_webhooks (011): different envelope, different auth
-- (X-Integration-Key, not HMAC) and a fixed target path. Dispatch is gated on
-- LOCKERHUB_EVENT_WEBHOOK_URL in SSM — absent (the default) nothing enqueues or
-- fires, so this is inert until LockerHub go-live.
--
-- Envelope stored in `payload`:
--   { event_id, event_type, occurred_at, phone, data:{ lockerhub_application_no, customer_code } }
-- `event_id` is the idempotency key (LockerHub is re-delivery safe on it).

CREATE TABLE IF NOT EXISTS customer_event_webhooks (
  id                    BIGSERIAL PRIMARY KEY,
  event_id              TEXT UNIQUE NOT NULL,   -- envelope idempotency key
  event_type            TEXT NOT NULL,          -- customer.synced | subscription.* | interest.paid | …
  phone                 TEXT,
  payload               JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed|abandoned
  attempts              INT NOT NULL DEFAULT 0,
  max_attempts          INT NOT NULL DEFAULT 10,
  next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at       TIMESTAMPTZ,
  sent_at               TIMESTAMPTZ,
  http_response_status  INT,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_events_pending
  ON customer_event_webhooks (next_attempt_at) WHERE status = 'pending';
