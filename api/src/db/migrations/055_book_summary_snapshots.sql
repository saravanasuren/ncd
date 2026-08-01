-- Daily snapshot of the outstanding book so the daily summary can show a real
-- day-over-day net change. Once a day rolls, the previous day's outstanding is
-- otherwise unknowable (outstanding_amount is point-in-time). One row per report
-- date; runBookSummary upserts today's figure after it computes.
CREATE TABLE IF NOT EXISTS book_summary_snapshots (
  report_date        DATE PRIMARY KEY,
  total_outstanding  NUMERIC(18,2) NOT NULL DEFAULT 0,
  active_apps        INTEGER       NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);
