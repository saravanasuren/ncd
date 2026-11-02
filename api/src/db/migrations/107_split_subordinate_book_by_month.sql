-- Owner 2026-11-02: split the subordinate book into one series per month.
--
--   "we need to split the investment receive in ncd 29, ncd bonds and ncd
--    doubling ... others all i want u to make it into seperate seperate series
--    named - Subordinate Debt 1, 2, 3 likely ... let those 12% ones remain in
--    ncd bond itself."
--
-- Buckets on date_money_received — the day the money landed — so the split is
-- driven by the data, not by a count taken beforehand. Money enrolled between
-- writing this and running it lands in the right month on its own.
--
-- WHAT STAYS BEHIND, deliberately:
--   · any investment with a 12% line. That is NCD BOND's nine 12-month lines
--     (Rs 3.31 cr, maturing Aug 2027) plus one stray on NCD 29 — the owner's
--     instruction, and the same money excluded from the 5-year extension.
--   · anything not live (Rejected/Cancelled), and anything whose approval was
--     REJECTED but whose status has not been flipped yet. That second clause
--     makes this independent of whether the rejection fix deployed first;
--     without it, two rejected investments would be moved into a live series.
--   · anything with no money-received date: there is no month to put it in.
--
-- The three source series are resolved BY CODE, never by id: the code is the
-- stable key (the name is editable in Settings) and an id hardcoded into a
-- migration silently matches nothing, or the wrong thing, in another database.
--
-- The whole thing is one guarded block because it must be a clean NO-OP on a
-- database that has no subordinate book — a fresh install, and every test
-- database. An earlier draft raised instead, which aborted server startup.
--
-- Every other assumption is asserted. If the live book does not look the way it
-- did when this was written, the migration RAISES rather than half-moving it.

DO $$
DECLARE
  src_ids   bigint[];
  missing   int;
  left_behind int;
  wrong_rate  int;
  moved       int;
BEGIN
  SELECT array_agg(id) INTO src_ids FROM series WHERE code IN ('NCD_29','NCD BOND','NCD Doubling');
  IF src_ids IS NULL THEN
    RAISE NOTICE 'migration 107: no subordinate series in this database - nothing to split';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM series WHERE code IN ('SD1','SD2','SD3','SD4','SD5')) THEN
    RAISE EXCEPTION 'a series already uses one of the SD1..SD5 codes - refusing to create duplicates';
  END IF;

  -- An investment inside an allotment batch cannot change series without
  -- orphaning it from that batch. None were in one when this was written.
  IF EXISTS (SELECT 1 FROM applications
              WHERE series_id = ANY(src_ids) AND batch_allotment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'an investment in these series belongs to an allotment batch - moving it would orphan the batch; resolve by hand';
  END IF;

  -- ── The five monthly series ───────────────────────────────────────────────
  -- Closed = closed to new money, records intact. November stays Open because it
  -- is the current month and must keep accepting enrolment.
  INSERT INTO series (code, name, status, face_value, close_date, is_subordinate, visible_in_app)
  SELECT v.code, v.name, v.status, src.face_value, v.close_date, TRUE, src.visible_in_app
    FROM (VALUES
      ('SD1', 'Subordinate Debt 1', 'Closed', DATE '2026-07-31'),
      ('SD2', 'Subordinate Debt 2', 'Closed', DATE '2026-08-31'),
      ('SD3', 'Subordinate Debt 3', 'Closed', DATE '2026-09-30'),
      ('SD4', 'Subordinate Debt 4', 'Closed', DATE '2026-10-31'),
      ('SD5', 'Subordinate Debt 5', 'Open',   DATE '2026-11-30')
    ) AS v(code, name, status, close_date)
    CROSS JOIN LATERAL (SELECT face_value, visible_in_app FROM series WHERE code = 'NCD_29') AS src;

  -- ── Which investments move, and where ─────────────────────────────────────
  CREATE TEMPORARY TABLE _move ON COMMIT DROP AS
  SELECT a.id AS application_id,
         a.series_id AS from_series_id,
         (SELECT s.id FROM series s WHERE s.code = 'SD' ||
            (CASE to_char(a.date_money_received, 'YYYY-MM')
               WHEN '2026-07' THEN '1' WHEN '2026-08' THEN '2' WHEN '2026-09' THEN '3'
               WHEN '2026-10' THEN '4' WHEN '2026-11' THEN '5' END)) AS to_series_id
    FROM applications a
   WHERE a.series_id = ANY(src_ids)
     AND a.archived_at IS NULL
     AND a.status NOT IN ('Rejected','Cancelled')
     AND a.date_money_received IS NOT NULL
     AND to_char(a.date_money_received, 'YYYY-MM') IN ('2026-07','2026-08','2026-09','2026-10','2026-11')
     AND NOT EXISTS (SELECT 1 FROM application_lines x
                      WHERE x.application_id = a.id AND x.coupon_rate_pct = 12)
     AND NOT (EXISTS (SELECT 1 FROM approval_requests ar
                       WHERE ar.entity_type = 'applications' AND ar.entity_id = a.id::text
                         AND ar.request_type = 'subscription' AND ar.status = 'Rejected')
          AND NOT EXISTS (SELECT 1 FROM approval_requests ar
                           WHERE ar.entity_type = 'applications' AND ar.entity_id = a.id::text
                             AND ar.status = 'Pending'));

  SELECT count(*) INTO missing FROM _move WHERE to_series_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'could not place % investment(s) into a monthly series', missing;
  END IF;

  -- Each new series offers the schemes its own investments actually use, so
  -- enrolment into the open November series works.
  INSERT INTO series_schemes (series_id, scheme_id)
  SELECT DISTINCT m.to_series_id, al.scheme_id
    FROM _move m JOIN application_lines al ON al.application_id = m.application_id
   WHERE al.scheme_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_data, after_data, created_at)
  SELECT NULL, 'application.series_moved', 'applications', m.application_id::text,
         jsonb_build_object('series_id', m.from_series_id),
         jsonb_build_object('series_id', m.to_series_id,
                            'note', 'Owner 2026-11-02: subordinate book split into one series per month of money received. Amounts, rates, tenure and schedules untouched.'),
         now()
    FROM _move m;

  UPDATE applications a
     SET series_id = m.to_series_id, updated_at = now()
    FROM _move m
   WHERE a.id = m.application_id;

  -- ── The emptied series close, records kept (owner's choice) ───────────────
  -- Closed means closed to NEW money; the leftover rejected records are exactly
  -- what "keep the records" refers to, so their presence must not block this.
  -- That nothing which SHOULD have moved is stuck here is proved by the
  -- left_behind post-check below, not by this condition.
  -- NCD BOND is deliberately absent: it still holds the live 12% money.
  UPDATE series SET status = 'Closed' WHERE code IN ('NCD_29', 'NCD Doubling');

  -- ── Post-checks: the book must still add up ───────────────────────────────
  SELECT count(*) INTO moved FROM _move;

  -- Nothing that should have moved may remain in the old series.
  SELECT count(*) INTO left_behind
    FROM applications a
   WHERE a.series_id = ANY(src_ids) AND a.archived_at IS NULL
     AND a.status NOT IN ('Rejected','Cancelled')
     AND a.date_money_received IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM application_lines x
                      WHERE x.application_id = a.id AND x.coupon_rate_pct = 12)
     -- Same exclusion as the move itself. Without it this post-check reports a
     -- deliberately-excluded rejected intent as a failure and aborts the split.
     AND NOT (EXISTS (SELECT 1 FROM approval_requests ar
                       WHERE ar.entity_type = 'applications' AND ar.entity_id = a.id::text
                         AND ar.request_type = 'subscription' AND ar.status = 'Rejected')
          AND NOT EXISTS (SELECT 1 FROM approval_requests ar
                           WHERE ar.entity_type = 'applications' AND ar.entity_id = a.id::text
                             AND ar.status = 'Pending'));
  IF left_behind > 0 THEN
    RAISE EXCEPTION 'post-check: % live non-12%% investment(s) still sit in the old series', left_behind;
  END IF;

  -- No 12% money may have been swept into a new series.
  SELECT count(*) INTO wrong_rate
    FROM applications a JOIN series s ON s.id = a.series_id
   WHERE s.code IN ('SD1','SD2','SD3','SD4','SD5')
     AND EXISTS (SELECT 1 FROM application_lines x
                  WHERE x.application_id = a.id AND x.coupon_rate_pct = 12);
  IF wrong_rate > 0 THEN
    RAISE EXCEPTION 'post-check: % 12%% investment(s) were moved and should not have been', wrong_rate;
  END IF;

  -- Every new series must be flagged subordinate and carry a close date, or its
  -- certificates would print the wrong form with a blank Effective Date.
  IF EXISTS (SELECT 1 FROM series WHERE code IN ('SD1','SD2','SD3','SD4','SD5')
              AND (is_subordinate IS NOT TRUE OR close_date IS NULL)) THEN
    RAISE EXCEPTION 'post-check: a new monthly series is missing its subordinate flag or close date';
  END IF;

  RAISE NOTICE 'migration 107: moved % investment(s) into the monthly subordinate series', moved;
END $$;
