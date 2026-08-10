-- Subordinate Bonds (owner spec, 2026-08-10).
--
-- A customer investment that is NOT an NCD. It behaves like one mechanically —
-- the owner confirmed the SAME approval gate, the SAME TDS rules and ₹30L
-- threshold, the SAME maturity and premature-penalty handling, the SAME
-- incentive matrix and the SAME interest calculation — but it belongs to no
-- series, carries its own number, and is reported and paid separately.
--
-- Because everything mechanical is shared, these stay in `applications` rather
-- than a parallel table: a second table would mean a second copy of approval,
-- TDS, incentives, payouts and redemption, all of which must then be kept in
-- step forever. What is NOT shared is a series, so series_id becomes optional
-- and a CHECK keeps the two shapes honest.

-- 1) What kind of investment this is.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'ncd';

-- 2) The Subordinate Bond product master. This is the sub-bond equivalent of
--    `schemes`: with no series there is no scheme, and the owner chose a
--    product master over per-investment rates so a rate change is one edit and
--    two customers on the same product cannot silently differ.
--
--    Deliberately NO min_ticket / multiple_of: the owner confirmed subordinate
--    bonds carry NO whole-₹1,00,000 unit rule, unlike NCDs.
CREATE TABLE IF NOT EXISTS sob_products (
  id                    BIGSERIAL PRIMARY KEY,
  code                  TEXT UNIQUE NOT NULL,
  name                  TEXT NOT NULL,
  tenure_months         INT NOT NULL,
  payout_frequency      TEXT NOT NULL DEFAULT 'Monthly',
  coupon_rate_pct       NUMERIC(7,4) NOT NULL,
  -- Same convention set as schemes.day_count_convention. The owner confirmed
  -- the interest CALCULATION is identical to an NCD's; only the reporting and
  -- the payout run are separate.
  day_count_convention  TEXT NOT NULL DEFAULT 'Actual365',
  tds_rule_id           BIGINT REFERENCES tds_rules(id),
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3) Which sub-bond product this investment is on.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sob_product_id BIGINT REFERENCES sob_products(id);

-- 4) A subordinate bond has no series, so series_id can no longer be mandatory.
ALTER TABLE applications ALTER COLUMN series_id DROP NOT NULL;

-- 5) Keep the two shapes from drifting into each other. Without this, a bug
--    that forgot to set product_type would produce an NCD with no series (which
--    every series report would then miscount), or a subordinate bond quietly
--    sitting inside a series — the exact thing the owner asked to prevent.
ALTER TABLE applications DROP CONSTRAINT IF EXISTS chk_app_product_shape;
ALTER TABLE applications ADD CONSTRAINT chk_app_product_shape CHECK (
  (product_type = 'ncd'              AND series_id IS NOT NULL AND sob_product_id IS NULL)
  OR
  (product_type = 'subordinate_bond' AND series_id IS NULL     AND sob_product_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_app_product_type ON applications(product_type);

-- 6) Numbering needs nothing here, and that is deliberate:
--
--    * the counter is a `number_sequences` row that nextSeq() creates on first
--      use, so SOB numbers run 1,2,3… independently of APP- with no seed; and
--    * the format is a code default in DEFAULT_NUMBER_FORMATS with an optional
--      `numbering.subordinate_bond_format` override, exactly as the application
--      and customer formats already work — neither of those is seeded either.
