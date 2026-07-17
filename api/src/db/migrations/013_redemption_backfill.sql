-- 013: Backfill maturity redemption log entries.
--
-- The legacy wealth app stored ONLY premature withdrawals in `redemptions`; a
-- maturity redemption was recorded solely as application.status='Redeemed' + a
-- payout. So redeemed investments imported before the migrate-legacy backfill
-- have no redemption log row and never appear in the Redemptions section (they
-- show only as the aggregated "redeemed" number).
--
-- This creates one redemption entry for every Redeemed application that has no
-- redemption row yet, from the data already present: principal = the investment
-- amount (interest was paid as coupons over the tenure), net payment = principal.
-- Idempotent (NOT EXISTS guard); a no-op on a freshly re-imported DB, where the
-- importer produces these rows instead.
INSERT INTO redemptions
  (redemption_no, application_id, type, principal, penalty, net_payment, broken_interest,
   requested_date, redemption_date, status)
SELECT
  CASE WHEN a.redemption_date IS NOT NULL AND a.maturity_date IS NOT NULL AND a.redemption_date < a.maturity_date
       THEN 'RED-PRE-' ELSE 'RED-MAT-' END || a.id,
  a.id,
  CASE WHEN a.redemption_date IS NOT NULL AND a.maturity_date IS NOT NULL AND a.redemption_date < a.maturity_date
       THEN 'premature' ELSE 'maturity' END,
  a.total_amount, 0, a.total_amount, 0,
  COALESCE(a.redemption_date, a.maturity_date),
  COALESCE(a.redemption_date, a.maturity_date),
  'Paid'
FROM applications a
WHERE a.status = 'Redeemed'
  AND NOT EXISTS (SELECT 1 FROM redemptions r WHERE r.application_id = a.id);
