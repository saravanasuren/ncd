-- Subordinate bond interest runs separately from NCD interest (owner 2026-08-10:
-- "A completely separate run" — its own batch, its own summary sheet, its own
-- NEFT file).
--
-- The CALCULATION is untouched and must stay so: the owner chose "same
-- calculation, kept separate". This column only says which run a batch belongs
-- to; nothing about how a figure is worked out changes.
ALTER TABLE payout_batches ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'ncd';

-- Every batch that already exists is an NCD interest run, and the DEFAULT above
-- has already labelled them so. No backfill, and no historical figure moves.
CREATE INDEX IF NOT EXISTS idx_payout_batches_product ON payout_batches(product_type, payout_date);
