-- 067_certificate_numbers_strict — a certificate number must never repeat.
-- Owner 2026-08-10: "make sure the numbers never gets duplicated ever. make it
-- strictly."
--
-- `applications.bond_serial_no` was already protected by a unique index (031).
-- `consolidated_bonds` was NOT: it only had UNIQUE (customer_id, series_id),
-- which stops one customer holding two certificates for a series but does
-- nothing to stop TWO customers being handed the SAME CB- number. That is the
-- hole this closes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_consolidated_bonds_serial
  ON consolidated_bonds(bond_serial_no);

-- Heal the counters if either is sitting BELOW a number already in use.
-- number_sequences.next_value is the number the NEXT allocation will take, so
-- it must always exceed the highest serial already issued. A restore from an
-- older dump, a hand-edit, or an import can leave it behind — and a counter
-- that is behind is exactly how a duplicate would be attempted. Idempotent: on
-- a healthy database both statements match nothing.
UPDATE number_sequences s
   SET next_value = used.high + 1
  FROM (SELECT max((regexp_replace(bond_serial_no, '^BC-\d+-', ''))::bigint) AS high
          FROM applications WHERE bond_serial_no ~ '^BC-\d+-\d+$') used
 WHERE s.key = 'bond' AND used.high IS NOT NULL AND s.next_value <= used.high;

UPDATE number_sequences s
   SET next_value = used.high + 1
  FROM (SELECT max((regexp_replace(bond_serial_no, '^CB-\d+-', ''))::bigint) AS high
          FROM consolidated_bonds WHERE bond_serial_no ~ '^CB-\d+-\d+$') used
 WHERE s.key = 'consolidated_bond' AND used.high IS NOT NULL AND s.next_value <= used.high;
