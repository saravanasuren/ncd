-- Owner 2026-11-16: "SD1 -> Debenture 1 ... SD5 -> Debenture 5", and, asked
-- whether the rename was for display only: "both display and internal code
-- should be changed to debenture 1-5."
--
-- SD1-SD5 are the monthly tranches migration 107 split the subordinate book
-- into. "SD" was only ever shorthand for Subordinate Debt, and it leaked: the
-- enrolment dropdown lists series by CODE, so staff chose between SD4 and SD5,
-- and the certificate printed "SD4 - Subordinate Debt 4" at the holder.
--
-- CODE AND NAME BOTH MOVE, and both become the same string. A code that says
-- one thing while the name says another is what produced "SD4 - Subordinate
-- Debt 4" in the first place.
--
-- WHAT THIS IS SAFE TO DO. Checked before writing: no application code keys on
-- these codes. `isSubordinate` reads the `is_subordinate` FLAG and says so in
-- its own comment ("NOT from the code or the name"); the customer app is sent
-- series_id plus the name to display; allotments, reports and the payout engine
-- all join on series_id. The only matches for 'SD%' outside this file are
-- migrations 107-109, which have already run and are guarded against running
-- twice, and the --series-like USAGE EXAMPLE in realign-maturity-to-series.ts,
-- updated in the same commit.
--
-- NCD 1-28 ARE NOT TOUCHED. Owner, same message: "Do not disturb NCD Series
-- 1-28 under any circumstances." This matches the five codes exactly - not a
-- LIKE, not a prefix - so there is no pattern here that could reach them.

DO $$
DECLARE
  r      record;
  moved  int := 0;
BEGIN
  -- Nothing to rename on a fresh install or a test database: migration 107
  -- only creates SD1-SD5 where the subordinate book already existed.
  IF NOT EXISTS (SELECT 1 FROM series WHERE code IN ('SD1','SD2','SD3','SD4','SD5')) THEN
    RAISE NOTICE 'migration 114: no SD series here - nothing to rename';
    RETURN;
  END IF;

  -- A code is unique. If anything already sits on a target name, stop rather
  -- than fail halfway through with three series renamed and two not.
  IF EXISTS (
    SELECT 1 FROM series
     WHERE code IN ('Debenture 1','Debenture 2','Debenture 3','Debenture 4','Debenture 5')
  ) THEN
    RAISE EXCEPTION 'a series already uses one of the Debenture 1-5 codes - resolve by hand';
  END IF;

  FOR r IN
    SELECT id, code, name, 'Debenture ' || substring(code from 3) AS want
      FROM series WHERE code IN ('SD1','SD2','SD3','SD4','SD5') ORDER BY code
  LOOP
    INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_data, after_data, created_at)
    VALUES (NULL, 'series.renamed', 'series', r.id::text,
            jsonb_build_object('code', r.code, 'name', r.name),
            jsonb_build_object('code', r.want, 'name', r.want,
              'note', 'Owner 2026-11-16: SD1-SD5 become Debenture 1-5, code and name. Nothing else about the series changes.'),
            now());

    -- NB: `series` has no updated_at column (001_core) - do not add one here.
    UPDATE series SET code = r.want, name = r.want WHERE id = r.id;
    moved := moved + 1;
  END LOOP;

  -- ── Post-checks ──────────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM series WHERE code IN ('SD1','SD2','SD3','SD4','SD5')) THEN
    RAISE EXCEPTION 'post-check: an SD series code survived the rename';
  END IF;

  IF (SELECT count(*) FROM series
       WHERE code IN ('Debenture 1','Debenture 2','Debenture 3','Debenture 4','Debenture 5')) <> moved THEN
    RAISE EXCEPTION 'post-check: % series renamed but a different number carry the new codes', moved;
  END IF;

  -- The rename must not have changed what a series IS. Every renamed series is
  -- still subordinate, and still carries the close date its maturities are
  -- calculated from - the two columns a careless UPDATE here would cost money.
  IF EXISTS (
    SELECT 1 FROM series
     WHERE code LIKE 'Debenture %'
       AND (is_subordinate IS DISTINCT FROM TRUE OR close_date IS NULL)
  ) THEN
    RAISE EXCEPTION 'post-check: a renamed series lost its subordinate flag or its close date';
  END IF;

  RAISE NOTICE 'migration 114: renamed % series SD1-SD5 -> Debenture 1-5', moved;
END $$;
