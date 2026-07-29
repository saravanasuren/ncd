-- 048_notification_delivery — make a queued message traceable and retryable.
--
-- Batch NEFT-2026-000131 (28 Jul 2026) paid 384 customers and 275 of them
-- never got the WhatsApp: the sends fired back-to-back, WappCloud returned
-- 429 "Too many requests from this IP, please try again after 15 minutes",
-- and a failed row was terminal — nothing ever retried it. Nothing recorded
-- which batch a message belonged to either, so no screen could show it.
--
-- Columns added here, all nullable/defaulted so existing rows stay valid:
--   customer_id      — WHO it was for. Matching on phone alone is ambiguous:
--                      families share a number, so one number can cover two
--                      customers and a per-customer answer is impossible.
--   ref_kind/ref_id  — WHAT it belonged to ('payout_batch' + batch id).
--   next_attempt_at  — WHEN it may next be tried. Retry + backoff hang off
--                      this; a rate-limited row is simply pushed forward.
-- Idempotent; Postgres + PGlite.

ALTER TABLE notifications_queue ADD COLUMN IF NOT EXISTS customer_id     BIGINT REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE notifications_queue ADD COLUMN IF NOT EXISTS ref_kind        TEXT;
ALTER TABLE notifications_queue ADD COLUMN IF NOT EXISTS ref_id          BIGINT;
ALTER TABLE notifications_queue ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- The drain picks Pending rows that are due. Without this it scans the whole
-- table every 60s once the queue has any history.
CREATE INDEX IF NOT EXISTS idx_notif_due ON notifications_queue(status, next_attempt_at);

-- "Show me this batch's messages" — the query behind the new status panel.
CREATE INDEX IF NOT EXISTS idx_notif_ref ON notifications_queue(ref_kind, ref_id);
