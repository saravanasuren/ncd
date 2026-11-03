-- Owner 2026-11-03: "the series close date is the allotment date. the redemption
-- date / maturity date should be calculated from series close date + tenure."
--
-- The interest engine ALREADY works this way and always has:
--   lib/interest.ts  -> maturityDate = addMonths(seriesDeemedDate, tenure)
--   materialize.ts   -> seriesDeemedDate = series.deemed_date ?? interestStartDate
--
-- The reason every investment matures on its own money-received date is simply
-- that series.deemed_date is NULL on these series, so the engine falls back to
-- the money date. Setting it is the entire fix for everything enrolled from now
-- on — no change to the interest engine, which is locked.
--
-- INTEREST IS NOT MOVED. It still accrues from each customer's own
-- date_money_received (owner's decision, 2026-11-03): maturity moving later
-- means an early payer earns slightly MORE than the nominal term, and none of
-- the 372 already-settled rows has to be recomputed or recovered.
--
-- Only the SD series are touched. NCD BOND still holds the live 12% money whose
-- term the owner deliberately left alone, and giving it a deemed date would move
-- those maturities.
--
-- Existing schedules are NOT rebuilt here — that needs the interest engine, not
-- SQL. api/src/scripts/realign-maturity-to-series.ts does it, and must be run
-- after this migration.

-- ── The two that were filed in the wrong month ─────────────────────────────
-- Both were dated October when the split ran this morning and landed in SD4.
-- They were approved since, with the money-received date edited to 2 November,
-- so they are November money sitting in the October series — and the only two
-- whose maturity would otherwise be pulled EARLIER, which is how they surfaced.
-- Re-filed by their CURRENT date, generically, so any other drift is caught too.
UPDATE applications a
   SET series_id = want.id, updated_at = now()
  FROM series cur, series want
 WHERE a.series_id = cur.id
   AND cur.code LIKE 'SD%'
   AND want.code = 'SD' || (CASE to_char(a.date_money_received, 'YYYY-MM')
         WHEN '2026-07' THEN '1' WHEN '2026-08' THEN '2' WHEN '2026-09' THEN '3'
         WHEN '2026-10' THEN '4' WHEN '2026-11' THEN '5' END)
   AND want.id <> cur.id
   AND a.date_money_received IS NOT NULL
   AND a.archived_at IS NULL;

-- ── The series close date IS the deemed date of allotment ──────────────────
UPDATE series SET deemed_date = close_date
 WHERE code LIKE 'SD%' AND close_date IS NOT NULL
   AND deemed_date IS DISTINCT FROM close_date;

-- ── ...and the allotment date on every investment in them ──────────────────
-- NULL on all 230 today, so nothing operator-entered is overwritten.
UPDATE applications a
   SET allotment_date = s.close_date, updated_at = now()
  FROM series s
 WHERE a.series_id = s.id AND s.code LIKE 'SD%' AND s.close_date IS NOT NULL
   AND a.archived_at IS NULL
   AND a.allotment_date IS DISTINCT FROM s.close_date;

-- ── Post-checks ────────────────────────────────────────────────────────────
DO $$
DECLARE bad int;
BEGIN
  -- Every SD series must anchor maturity somewhere, or its investments fall
  -- back to the money date and the whole point is lost.
  SELECT count(*) INTO bad FROM series WHERE code LIKE 'SD%' AND deemed_date IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'post-check: % SD series still have no deemed date', bad; END IF;

  -- Nothing may sit in a series whose month it does not belong to.
  SELECT count(*) INTO bad
    FROM applications a JOIN series s ON s.id = a.series_id
   WHERE s.code LIKE 'SD%' AND a.archived_at IS NULL AND a.date_money_received IS NOT NULL
     AND s.code <> 'SD' || (CASE to_char(a.date_money_received, 'YYYY-MM')
           WHEN '2026-07' THEN '1' WHEN '2026-08' THEN '2' WHEN '2026-09' THEN '3'
           WHEN '2026-10' THEN '4' WHEN '2026-11' THEN '5' END);
  IF bad > 0 THEN RAISE EXCEPTION 'post-check: % investment(s) sit in the wrong month''s series', bad; END IF;

  -- No already-paid row may fall beyond the maturity this implies, or the
  -- realign script would have to rewrite settled money.
  SELECT count(*) INTO bad
    FROM disbursement_schedule d
    JOIN applications a ON a.id = d.application_id
    JOIN series s ON s.id = a.series_id
    JOIN application_lines l ON l.application_id = a.id
   WHERE s.code LIKE 'SD%' AND d.status = 'Paid'
     AND d.due_date > (s.close_date + (l.tenure_months || ' months')::interval)::date;
  IF bad > 0 THEN
    RAISE EXCEPTION 'post-check: % already-PAID row(s) would fall past the new maturity', bad;
  END IF;
END $$;
