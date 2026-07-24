-- Owner 2026-07-24: a redemption's broken-period interest is no longer bundled
-- into the redemption transfer — it is paid in THAT MONTH's interest batch as a
-- 'Redemption' row. The redemption sheet now pays principal (less penalty) only.
--
-- The BrokenInterest schedule row is what the monthly batch picks up, so its TDS
-- must be recorded at request time; it used to be derived from
-- net_payment − principal, which no longer holds once net_payment excludes it.
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS broken_tds NUMERIC(14,2) NOT NULL DEFAULT 0;
