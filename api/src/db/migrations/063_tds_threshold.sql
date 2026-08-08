-- 063_tds_threshold — cumulative-investment TDS applicability (owner 2026-08-07).
--
-- When a customer's outstanding NCD book crosses the threshold (default ₹30L)
-- they must switch from TDS-not-applicable to applicable, and the TDS on the
-- interest already paid to them (while untaxed) has to be recovered as a
-- one-time deduction on the next interest payout. A nightly scan detects the
-- crossing and raises ONE approval per customer; on approval the customer flips
-- to TDS-applicable and the recovery rides the next batch as a payout_adjustment.
--
-- This table is the audit trail + the guard against re-raising / double-charging.
-- Idempotent; Postgres + PGlite.

CREATE TABLE IF NOT EXISTS tds_threshold_events (
  id                      BIGSERIAL PRIMARY KEY,
  customer_id             BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  outstanding_at_crossing NUMERIC(16,2) NOT NULL,   -- the book that tripped it
  crossed_on              DATE,                       -- when it crossed (best-effort)
  interest_paid_untaxed   NUMERIC(16,2) NOT NULL,     -- interest paid while not-applicable
  tds_rate_pct            NUMERIC(6,3) NOT NULL,
  tds_to_recover          NUMERIC(16,2) NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'PendingApproval', -- PendingApproval|Applied|Rejected
  approval_request_id     BIGINT,
  payout_adjustment_id    BIGINT REFERENCES payout_adjustments(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tds_events_customer ON tds_threshold_events(customer_id);
-- Never two open (or applied) events for the same customer — the scan won't
-- re-raise while one is in flight or already done. A rejected one may re-raise.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tds_events_open
  ON tds_threshold_events(customer_id) WHERE status IN ('PendingApproval', 'Applied');
