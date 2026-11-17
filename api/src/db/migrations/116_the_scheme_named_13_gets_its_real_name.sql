-- Owner 2026-11-17, shown that six Debenture 5 certificates would print a
-- Scheme row reading "13": "Rename the scheme to match."
--
-- The new Scheme row on the Debenture certificate prints schemes.name as it
-- stands. Scheme 13_M36_13 is stored with the name "13" - two characters that
-- read like nothing at all to a holder looking at their own certificate.
-- Its terms are identical to 13_M36_MONTHLY: 36 months, 13.0000%, Monthly.
-- So this is a DISPLAY NAME correction and nothing more.
--
-- WHAT THIS IS SAFE TO DO. Checked before writing:
--   * Nothing in the application matches a scheme by NAME. `schemes.code` is
--     the unique key and is what the LockerHub integration matches on; that
--     code is NOT touched here. Every join is on scheme_id.
--   * `schemes.name` carries no UNIQUE constraint (001_core), so sharing a
--     name with 13_M36_MONTHLY cannot fail the migration.
--   * The enrolment dropdown filters `is_active !== false` and 13_M36_13 is
--     INACTIVE, so the two identical names can never both be offered to staff
--     at enrolment. They do both appear on the Schemes admin page, told apart
--     by their code - a known, accepted consequence of the owner's choice.
--   * `schemes` has NO updated_at column. Do not add one to this UPDATE; that
--     mistake was caught in migration 114 and would fail the deploy here.
--
-- NO INVESTMENT MOVES. The six holdings stay on 13_M36_13. Nothing about a
-- rate, a tenure, a schedule or a rupee changes - only what the certificate
-- prints. Re-running is harmless: the WHERE clause no longer matches.

DO $$
DECLARE
  renamed int := 0;
BEGIN
  UPDATE schemes
     SET name = '13% - 36 Months - Monthly'
   WHERE code = '13_M36_13'
     AND btrim(name) = '13';
  GET DIAGNOSTICS renamed = ROW_COUNT;

  IF renamed = 0 THEN
    RAISE NOTICE 'scheme 13_M36_13 was not named "13" - nothing to rename';
  ELSE
    RAISE NOTICE 'renamed % scheme(s)', renamed;
  END IF;

  -- The terms must not have drifted from the scheme whose name it now shares.
  -- If they ever do, the shared name becomes a lie and this must be revisited.
  IF EXISTS (
    SELECT 1 FROM schemes a JOIN schemes b ON b.code = '13_M36_MONTHLY'
     WHERE a.code = '13_M36_13'
       AND (a.tenure_months IS DISTINCT FROM b.tenure_months
         OR a.coupon_rate_pct IS DISTINCT FROM b.coupon_rate_pct
         OR a.payout_frequency IS DISTINCT FROM b.payout_frequency)
  ) THEN
    RAISE EXCEPTION '13_M36_13 no longer matches 13_M36_MONTHLY on term/rate/frequency - the shared name would misstate the product';
  END IF;
END $$;
