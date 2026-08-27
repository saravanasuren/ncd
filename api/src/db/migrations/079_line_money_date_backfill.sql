-- 079_line_money_date_backfill — every credit line carries its own money date.
--
-- The payout sheet resolves a period start as
--   COALESCE(<paid watermark>, line.date_money_received, app.interest_start_date)
-- so a line left NULL silently leans on the application's interest_start_date.
-- That is invisible until interest_start_date is wrong, and then the accrual is
-- wrong with nothing on screen to show it (Mythili D APP-2026-001083, 2026-08-26).
--
-- 🔒 interest-logic-locked — this is a deliberate NO-OP on every figure.
-- It backfills each dateless line with interest_start_date, which is EXACTLY the
-- value the COALESCE already falls through to, so no period start moves and no
-- payout changes. It only makes the dependency explicit, which is what lets the
-- payout health check treat a dateless line as a fault rather than as normal.
--
-- Deliberately NOT date_money_received: where the two disagree, copying the
-- money date would silently CHANGE the accrual. Those cases are for the health
-- check to surface and a human to correct, not for a migration to guess at.
--
-- Idempotent (only touches NULLs); Postgres + PGlite.
UPDATE application_lines l
   SET date_money_received = a.interest_start_date
  FROM applications a
 WHERE a.id = l.application_id
   AND l.date_money_received IS NULL
   AND a.interest_start_date IS NOT NULL;
