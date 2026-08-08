-- 064_tds_threshold_source — two gaps in 063 (owner 2026-08-08).
--
-- 1. A REJECTED event no longer blocks the scan, so the 6-hourly cron re-raised
--    the same approval within hours of the owner rejecting it — forever. The
--    scan now treats 'Rejected' as final too; `Reopened` is the explicit
--    "look at this customer again" escape hatch (set from the TDS page).
--
-- 2. The enrolment prompt (">₹30L for a No-TDS customer → apply TDS?" in
--    applications/service.ts) flipped the customer WITHOUT recovering the TDS on
--    interest already paid — a second door into TDS-applicable that collected
--    nothing. That path now raises the same recovery approval, marked
--    `is_estimate` because the historic per-payout TDS may differ from a flat
--    rate applied to the total. `source` says which door raised it.
--
-- Idempotent; Postgres + PGlite.

ALTER TABLE tds_threshold_events ADD COLUMN IF NOT EXISTS source      TEXT NOT NULL DEFAULT 'scan'; -- scan | enrolment
ALTER TABLE tds_threshold_events ADD COLUMN IF NOT EXISTS is_estimate BOOLEAN NOT NULL DEFAULT FALSE;

-- Who reopened a rejected event, and when — the audit trail for un-dismissing.
ALTER TABLE tds_threshold_events ADD COLUMN IF NOT EXISTS reopened_at      TIMESTAMPTZ;
ALTER TABLE tds_threshold_events ADD COLUMN IF NOT EXISTS reopened_by_user_id BIGINT;

-- 'Rejected' is now terminal for the scan, so it must not be re-raisable while
-- it stands. Reopening moves it to 'Reopened', which frees the customer again.
DROP INDEX IF EXISTS uq_tds_events_open;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tds_events_open
  ON tds_threshold_events(customer_id) WHERE status IN ('PendingApproval', 'Applied', 'Rejected');
