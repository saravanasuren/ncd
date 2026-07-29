-- 050_notification_application — a message can now name ONE investment.
--
-- Owner 2026-07-29: "need not club every investment into one message and send.
-- send separate messages for each investment." A customer holding 8 debentures
-- was getting one message with the eight interest amounts added together.
--
-- application_id is what makes the split safe to repeat: "have we told them
-- about THIS debenture yet" cannot be answered by customer alone once one
-- customer receives several messages for the same batch.
--
-- NULL keeps its own meaning and must not be backfilled with a guess: a NULL
-- row is one of the OLD clubbed messages, which covered every investment that
-- customer had in the batch. The top-up logic reads it exactly that way, so
-- the 92 customers already messaged for NEFT-2026-000131 are not messaged
-- again now that the split is on.
--
-- Idempotent; Postgres + PGlite.

ALTER TABLE notifications_queue ADD COLUMN IF NOT EXISTS application_id BIGINT REFERENCES applications(id) ON DELETE SET NULL;

-- "Which investments in this batch have already been told?" — the lookup the
-- send does before queueing anything.
CREATE INDEX IF NOT EXISTS idx_notif_ref_app ON notifications_queue(ref_kind, ref_id, application_id);
