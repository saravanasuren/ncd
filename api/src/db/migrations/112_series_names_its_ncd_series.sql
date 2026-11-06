-- Owner 2026-11-06, on the first NCD certificate printed for a subordinate
-- holding: "category should show the NCD series, in vasanthamani case, it
-- should be NCD_29".
--
-- The Category row on the Debenture form printed "SD5 Series". SD1-SD5 are a
-- re-filing of the NCD 29 book by month of money received (migration 107); the
-- tranche code is an internal filing device and means nothing to an NCD holder.
-- The NCD form must name the series the money was raised under.
--
-- WHY A COLUMN AND NOT A DERIVATION. Migration 107 did log each move
-- (application.series_moved, before_data.series_id), so the origin COULD be
-- read back per investment. It must not be:
--   · anything enrolled into SD5 since the split has no such row, so the
--     newest money — exactly the money being certificated now — would print a
--     blank Category;
--   · a consolidated certificate covers several investments, which could
--     disagree on origin and have no single answer to print;
--   · NCD BOND and NCD Doubling also fed the split, so the answer is not one
--     constant either.
-- One explicit value per series, visible and changeable, is the honest model.
--
-- NOTHING IS RE-FILED. No application moves series, no amount, rate, tenure,
-- maturity date or schedule row is touched. This adds a label the NCD form
-- reads, and only on a series that has one set.

ALTER TABLE series ADD COLUMN IF NOT EXISTS ncd_series_id BIGINT REFERENCES series(id);

COMMENT ON COLUMN series.ncd_series_id IS
  'The NCD series this (subordinate) tranche was raised under. The NCD / Debenture form prints its code as Category; NULL means the series prints its own code, as it always has.';

-- The five monthly tranches were split out of NCD 29, so that is what their NCD
-- form names. Keyed on CODE, never on id, and a clean no-op where the book does
-- not exist — a fresh install and every test database.
DO $$
DECLARE ncd29 bigint;
BEGIN
  SELECT id INTO ncd29 FROM series WHERE code = 'NCD_29';
  IF ncd29 IS NULL THEN
    RAISE NOTICE 'migration 112: NCD_29 not present - nothing to point at';
    RETURN;
  END IF;

  UPDATE series SET ncd_series_id = ncd29
   WHERE code IN ('SD1','SD2','SD3','SD4','SD5')
     AND ncd_series_id IS NULL;

  -- A series may never point at itself: the Category row would recurse into the
  -- same name and the column would be telling the form nothing.
  IF EXISTS (SELECT 1 FROM series WHERE ncd_series_id = id) THEN
    RAISE EXCEPTION 'post-check: a series points at itself as its NCD series';
  END IF;

  -- Only the subordinate tranches are labelled. NCD 27 / NCD 28 keep printing
  -- their own code, which is the one thing that must not move.
  IF EXISTS (SELECT 1 FROM series WHERE ncd_series_id IS NOT NULL AND is_subordinate IS NOT TRUE) THEN
    RAISE EXCEPTION 'post-check: a non-subordinate series was given an NCD series label';
  END IF;
END $$;
