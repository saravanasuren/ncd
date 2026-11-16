-- Owner 2026-11-16: "The certificate number must follow this structure:
-- DC/2026/SD/00001 ... Start the numbering sequence from 00001 ... Ensure that
-- duplicate certificate numbers are never generated."
--
-- Asked whether the Debenture form should carry a SEPARATE run from the
-- Subordinate Bond form, the owner said: "rename both as - DC/2026/SD/00001."
-- So it stays ONE number per holding, printed on both renderings, now in the
-- new shape. That keeps the rule #513 was built around: one holding can never
-- look like two instruments.
--
-- Asked what happens to numbers already printed, the owner chose to renumber
-- everything, and the order: by DATE OF THE HOLDING - the money that came in
-- first takes 00001, whichever certificate happened to be printed first.
--
-- A CERTIFICATE ALREADY IN A CUSTOMER'S HANDS WILL SHOW A NUMBER THIS DATABASE
-- NO LONGER HOLDS. That was put to the owner in those words and accepted. So
-- the old number is KEPT, in previous_bond_serial_no and in the audit row: a
-- holder ringing up with SD-2026-0096 can still be found.
--
-- The format itself lives in lib/numbering.ts and the year-scoped counter in
-- forms/bond.ts. This migration only moves what is already issued.

ALTER TABLE consolidated_bonds ADD COLUMN IF NOT EXISTS previous_bond_serial_no TEXT;
COMMENT ON COLUMN consolidated_bonds.previous_bond_serial_no IS
  'The SD-2026-#### number this certificate carried before migration 115 renumbered it to DC/{year}/SD/#####. Kept so a holder quoting a number from a printed certificate can still be found.';

DO $$
DECLARE
  r       record;
  y       record;
  n       int;
  total   int := 0;
  stray   int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM consolidated_bonds WHERE bond_serial_no ~ '^SD-[0-9]{4}-[0-9]+$') THEN
    RAISE NOTICE 'migration 115: no SD- certificate numbers here - nothing to renumber';
  ELSE
    -- The run is numbered from 00001, as asked, which is only safe while the
    -- DC run is empty - and it is: this migration introduces the format. A
    -- database holding BOTH shapes is a state nobody planned, so say so
    -- plainly rather than failing on the unique index halfway through.
    IF EXISTS (SELECT 1 FROM consolidated_bonds WHERE bond_serial_no LIKE 'DC/%') THEN
      RAISE EXCEPTION 'DC/ certificate numbers already exist alongside SD- ones - renumbering from 00001 would collide; resolve by hand';
    END IF;

    -- One run per year, because the numbering restarts each January. The year
    -- is taken from the number already issued, never recomputed: a renumber
    -- must not move a holding into a different year's run.
    FOR y IN
      SELECT DISTINCT substring(bond_serial_no from 4 for 4)::int AS yr
        FROM consolidated_bonds
       WHERE bond_serial_no ~ '^SD-[0-9]{4}-[0-9]+$'
       ORDER BY 1
    LOOP
      n := 0;
      FOR r IN
        SELECT cb.customer_id, cb.series_id, cb.bond_serial_no AS old,
               (SELECT min(a.date_money_received)
                  FROM applications a
                 WHERE a.customer_id = cb.customer_id AND a.series_id = cb.series_id) AS held_from
          FROM consolidated_bonds cb
         WHERE cb.bond_serial_no ~ '^SD-[0-9]{4}-[0-9]+$'
           AND substring(cb.bond_serial_no from 4 for 4)::int = y.yr
         -- The owner's choice: by when the money arrived. A holding with no
         -- date at all goes last rather than first, and the old number breaks
         -- the tie so the result is deterministic.
         ORDER BY held_from NULLS LAST, cb.bond_serial_no
      LOOP
        n := n + 1;

        INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_data, after_data, created_at)
        VALUES (NULL, 'certificate.renumbered', 'consolidated_bonds',
                r.customer_id::text || ':' || r.series_id::text,
                jsonb_build_object('bond_serial_no', r.old),
                jsonb_build_object('bond_serial_no', 'DC/' || y.yr || '/SD/' || lpad(n::text, 5, '0'),
                  'note', 'Owner 2026-11-16: one number per holding, in the DC/{year}/SD/##### format, ordered by date of the holding. The previous number is kept on the row.'),
                now());

        UPDATE consolidated_bonds
           SET previous_bond_serial_no = COALESCE(previous_bond_serial_no, bond_serial_no),
               bond_serial_no = 'DC/' || y.yr || '/SD/' || lpad(n::text, 5, '0')
         WHERE customer_id = r.customer_id AND series_id = r.series_id;
      END LOOP;

      -- The counter the next certificate draws from. nextSeq returns the value
      -- standing here, so the next number out is n + 1.
      INSERT INTO number_sequences (key, next_value)
      VALUES ('subordinate_debt:' || y.yr, n + 1)
      ON CONFLICT (key) DO UPDATE SET next_value = GREATEST(number_sequences.next_value, EXCLUDED.next_value);

      RAISE NOTICE 'migration 115: % certificate(s) renumbered into DC/%/SD/, counter at %', n, y.yr, n + 1;
      total := total + n;
    END LOOP;
  END IF;

  -- A per-investment certificate could in principle hold an SD- number too.
  -- None can have been minted since 2026-11-03 (bondCertificatePdf refuses to
  -- issue one for a subordinate series), and the eight issued before that wear
  -- BC- numbers. Reported rather than renumbered: these are separate documents
  -- and would need their own decision.
  SELECT count(*) INTO stray FROM applications WHERE bond_serial_no ~ '^SD-[0-9]{4}-[0-9]+$';
  IF stray > 0 THEN
    RAISE NOTICE 'migration 115: % investment-level SD- number(s) left as they are - raise with the owner', stray;
  END IF;

  -- ── Post-checks ──────────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM consolidated_bonds WHERE bond_serial_no ~ '^SD-[0-9]{4}-[0-9]+$') THEN
    RAISE EXCEPTION 'post-check: an SD- certificate number survived the renumber';
  END IF;

  IF EXISTS (
    SELECT bond_serial_no FROM consolidated_bonds
     WHERE bond_serial_no IS NOT NULL GROUP BY bond_serial_no HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'post-check: certificate numbers are no longer unique';
  END IF;

  -- Every renumbered row kept the number it used to carry. Counted, not
  -- tested as "DC/ implies a previous number": a certificate minted AFTER this
  -- migration is DC/ with no previous number at all, and that is correct.
  IF (SELECT count(*) FROM consolidated_bonds WHERE previous_bond_serial_no IS NOT NULL) < total THEN
    RAISE EXCEPTION 'post-check: % renumbered but fewer rows carry a previous number', total;
  END IF;

  RAISE NOTICE 'migration 115: % certificate(s) renumbered in all', total;
END $$;
