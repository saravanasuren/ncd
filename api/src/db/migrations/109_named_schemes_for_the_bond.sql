-- Owner 2026-11-03: the bond prints the scheme, so the schemes need real names.
--
-- Scheme 1 is named literally "13". Printed on a certificate that reads
-- "Scheme: 13", which means nothing to a holder — and it is on 474 investments.
--
-- It must NOT simply be renamed. The owner caught this: that scheme still
-- carries NCD 27 (132 lines, Rs 9.00 cr) and NCD 28 (98 lines, Rs 4.91 cr), both
-- 36-MONTH. Calling it "13% - 60 Months - Monthly" would label Rs 13.91 crore of
-- 36-month investments as 60-month. So a NEW scheme is added for the 60-month
-- business and the old one is put back to what it actually describes.
--
-- End state, the two active schemes the owner described:
--   · 13% - 60 Months - Monthly   (new; SD1-SD5 and all new subordinate money)
--   · Doubling - 60 Months        (renamed)
-- with the rest switched off so they cannot be picked at enrolment.
--
-- Everything is keyed on CODE, never on id, and the whole thing is one guarded
-- block so it is a clean NO-OP on a database that does not have this book — a
-- fresh install, and every test database. An earlier draft asserted instead,
-- which aborted server startup everywhere.

DO $$
DECLARE
  old_id bigint;
  new_id bigint;
  bad    int;
BEGIN
  SELECT id INTO old_id FROM schemes WHERE code = '13_M36_13';
  IF old_id IS NULL THEN
    RAISE NOTICE 'migration 109: scheme 13_M36_13 not present - nothing to rename';
    RETURN;
  END IF;

  -- ── The new 60-month scheme ──────────────────────────────────────────────
  -- Everything except name, code and tenure is copied from the old one, so
  -- moving a line onto it changes the LABEL and nothing else: same face value,
  -- same ticket rules, same day count, same commission rule and — the one that
  -- would quietly alter money — the same TDS rule.
  INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct,
                       face_value, min_ticket, multiple_of, day_count_convention,
                       commission_rule, tds_rule_id, is_active)
  SELECT '13_M60_MONTHLY', '13% - 60 Months - Monthly', 60, 'Monthly', 13,
         s.face_value, s.min_ticket, s.multiple_of, s.day_count_convention,
         s.commission_rule, s.tds_rule_id, TRUE
    FROM schemes s WHERE s.id = old_id
     AND NOT EXISTS (SELECT 1 FROM schemes x WHERE x.code = '13_M60_MONTHLY');

  SELECT id INTO new_id FROM schemes WHERE code = '13_M60_MONTHLY';

  -- ── The 60-month money moves onto it ────────────────────────────────────
  -- SD1-SD5 only, and only the 60-month lines: SD5 holds one 36-month
  -- investment that must not be relabelled, and NCD 27 / NCD 28 stay put.
  UPDATE application_lines al
     SET scheme_id = new_id
    FROM applications a, series se
   WHERE al.application_id = a.id AND a.series_id = se.id
     AND se.code LIKE 'SD%'
     AND al.scheme_id = old_id
     AND al.tenure_months = 60
     AND a.archived_at IS NULL;

  -- ── Doubling gets its real name ─────────────────────────────────────────
  UPDATE schemes SET name = 'Doubling - 60 Months' WHERE code = '20%';

  -- ── The old scheme describes the money it holds, and is retired ─────────
  -- Its tenure was changed to 60 in place on 2026-11-02 so new business came in
  -- at five years. That business now has its own scheme, so this goes back to
  -- the 36 months NCD 27 and NCD 28 actually ran for. Existing lines are
  -- unaffected either way — each stores its own tenure_months.
  UPDATE schemes SET tenure_months = 36, is_active = FALSE WHERE id = old_id;

  -- Everything else the owner named off, so only the two remain selectable.
  -- The 12% scheme stays in the data — ten NCD BOND lines use it — but no new
  -- money can be enrolled onto it.
  UPDATE schemes SET is_active = FALSE WHERE code IN ('12%', '15%');

  -- ── Doubling's maturity, by the same rule as everything else ────────────
  -- Owner 2026-11-03: "for doubling the maturity date is again the series close
  -- date + tenure." These are AtMaturity products that were never materialised,
  -- so they carry no maturity date at all and their bond would print a blank
  -- Date of Redemption. They have no schedule rows, so only the date is missing.
  UPDATE application_lines al
     SET maturity_date = (se.close_date + (al.tenure_months || ' months')::interval)::date
    FROM applications a, series se
   WHERE al.application_id = a.id AND a.series_id = se.id
     AND se.code LIKE 'SD%' AND se.close_date IS NOT NULL
     AND al.maturity_date IS NULL
     AND a.status IN ('Active','Matured','Redeemed','RolledOver');

  UPDATE applications a
     SET maturity_date = (se.close_date + (al.tenure_months || ' months')::interval)::date,
         updated_at = now()
    FROM series se, application_lines al
   WHERE a.series_id = se.id AND al.application_id = a.id
     AND se.code LIKE 'SD%' AND se.close_date IS NOT NULL
     AND a.maturity_date IS NULL
     AND a.status IN ('Active','Matured','Redeemed','RolledOver');

  -- ── Post-checks ──────────────────────────────────────────────────────────
  -- The new scheme must match the old one on the two fields that would change
  -- money if they differed.
  IF NOT EXISTS (
    SELECT 1 FROM schemes n, schemes o
     WHERE n.id = new_id AND o.id = old_id
       AND n.tds_rule_id IS NOT DISTINCT FROM o.tds_rule_id
       AND n.face_value  IS NOT DISTINCT FROM o.face_value
  ) THEN
    RAISE EXCEPTION 'post-check: the new scheme does not match the old one on TDS rule / face value';
  END IF;

  -- No 36-month line may have been relabelled as 60-month.
  SELECT count(*) INTO bad FROM application_lines WHERE scheme_id = new_id AND tenure_months <> 60;
  IF bad > 0 THEN RAISE EXCEPTION 'post-check: % line(s) on the 60-month scheme are not 60-month', bad; END IF;

  -- NCD 27 / NCD 28 must not have moved. This is the one the owner caught.
  SELECT count(*) INTO bad
    FROM application_lines al JOIN applications a ON a.id = al.application_id
    JOIN series se ON se.id = a.series_id
   WHERE se.code IN ('NCD_27','NCD_28') AND al.scheme_id = new_id;
  IF bad > 0 THEN RAISE EXCEPTION 'post-check: % older 36-month line(s) were moved onto the 60-month scheme', bad; END IF;

  -- The ones named for retirement must actually be unselectable.
  SELECT count(*) INTO bad FROM schemes
   WHERE code IN ('13_M36_13', '12%', '15%') AND is_active = TRUE;
  IF bad > 0 THEN RAISE EXCEPTION 'post-check: % retired scheme(s) are still active', bad; END IF;
END $$;
