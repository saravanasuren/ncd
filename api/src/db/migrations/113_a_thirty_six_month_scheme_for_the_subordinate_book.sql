-- Owner 2026-11-14: "for all the sd1,2,3,4,5 tenure is 36 months, not 60", and
-- on the customer app: "it should show 36 months, it showed 60 months".
--
-- The 60 the holder sees is a NAME, not a number. /integration/reads.ts sends
-- the app `scheme_name` and `maturity_date`; it never sends tenure_months. The
-- SD book sits on the scheme migration 109 created for the five-year business:
--
--     13_M60_MONTHLY  "13% - 60 Months - Monthly"
--
-- So correcting tenure_months and the schedule is not enough on its own — the
-- app, and the Scheme row on the bond certificate, would still read "60
-- Months". This adds the correctly named 36-month scheme for those lines to
-- move onto.
--
-- IT DOES NOT MOVE ANYTHING. Creating the scheme is inert: no line changes
-- scheme_id here, because a line's scheme must change in the same transaction
-- as its tenure, maturity date and schedule tail, or the app shows a 36-month
-- label against a 2031 maturity. scripts/shorten-tenure.ts --scheme does all of
-- it per line, atomically and audited. This migration only makes the
-- destination exist, so the deploy that carries it is safe on its own.
--
-- WHY NOT RENAME 13_M60_MONTHLY IN PLACE. Same reason migration 109 refused to
-- rename the scheme before it: a name must describe the money actually on it.
-- Lines legitimately at 60 months may remain (NCD Doubling is 60-month, and the
-- owner's instruction names SD1-SD5 only), and relabelling the scheme under
-- them would say something false about their term.
--
-- Everything except name, code and tenure is copied, so moving a line changes
-- the LABEL and nothing else: same face value, same ticket rules, same day
-- count, same commission rule and — the one that would quietly alter money —
-- the same TDS rule. Keyed on CODE, and a clean no-op where that scheme does
-- not exist: a fresh install, and every test database.

DO $$
DECLARE
  src_id bigint;
  new_id bigint;
BEGIN
  SELECT id INTO src_id FROM schemes WHERE code = '13_M60_MONTHLY';
  IF src_id IS NULL THEN
    RAISE NOTICE 'migration 113: scheme 13_M60_MONTHLY not present - nothing to mirror';
    RETURN;
  END IF;

  INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct,
                       face_value, min_ticket, multiple_of, day_count_convention,
                       commission_rule, tds_rule_id, is_active)
  SELECT '13_M36_MONTHLY', '13% - 36 Months - Monthly', 36, s.payout_frequency, s.coupon_rate_pct,
         s.face_value, s.min_ticket, s.multiple_of, s.day_count_convention,
         s.commission_rule, s.tds_rule_id, TRUE
    FROM schemes s WHERE s.id = src_id
     AND NOT EXISTS (SELECT 1 FROM schemes x WHERE x.code = '13_M36_MONTHLY');

  SELECT id INTO new_id FROM schemes WHERE code = '13_M36_MONTHLY';

  -- The two fields that would change money if they differed. Migration 109's
  -- own post-check, in the same place and for the same reason.
  IF NOT EXISTS (
    SELECT 1 FROM schemes n, schemes o
     WHERE n.id = new_id AND o.id = src_id
       AND n.tds_rule_id IS NOT DISTINCT FROM o.tds_rule_id
       AND n.face_value  IS NOT DISTINCT FROM o.face_value
  ) THEN
    RAISE EXCEPTION 'post-check: the 36-month scheme does not match the 60-month one on TDS rule / face value';
  END IF;

  IF (SELECT tenure_months FROM schemes WHERE id = new_id) <> 36 THEN
    RAISE EXCEPTION 'post-check: the 36-month scheme is not 36 months';
  END IF;

  -- Nothing may have been moved onto it by this migration.
  IF EXISTS (SELECT 1 FROM application_lines WHERE scheme_id = new_id) THEN
    RAISE EXCEPTION 'post-check: lines were moved onto the new scheme - that belongs to shorten-tenure, per line and in one transaction with the term';
  END IF;
END $$;
