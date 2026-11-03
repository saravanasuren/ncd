-- Owner 2026-11-02: the subordinate book is being split into one series per
-- month ("Subordinate Debt 1, 2, 3 likely"), and "all of these series named
-- subordinate bonds should only have this subordinate certificate".
--
-- Until now bond.ts decided that by matching the series CODE against a hardcoded
-- set {NCD_29, NCD BOND, NCD Doubling}. A new series would silently fall through
-- to the Debenture Certificate — telling the holder something untrue about where
-- they rank if the company fails. The decision moves onto the series row.
--
-- close_date is the series' own closing date. The owner's words: "i decide to
-- have the series close date to be the months last date and accordingly it is to
-- be the date of application. or we can also rename it as effective date." It is
-- printed on the subordinate certificate as the Effective Date, the same for
-- every bond in the series.
--
-- NB: this is NOT the `subordinate_bond` PRODUCT (product_type = 'subordinate_bond',
-- numbered SOB-...), which has no series at all. Different concept, same word.

ALTER TABLE series ADD COLUMN IF NOT EXISTS is_subordinate BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE series ADD COLUMN IF NOT EXISTS close_date DATE;

-- The three that are subordinate today keep behaving exactly as they do now.
UPDATE series SET is_subordinate = TRUE
 WHERE code IN ('NCD_29', 'NCD BOND', 'NCD Doubling')
   AND is_subordinate = FALSE;
