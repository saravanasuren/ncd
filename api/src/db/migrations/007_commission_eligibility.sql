-- 007_commission_eligibility — agent commission rate column (docs/00 §7).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS commission_rate_pct NUMERIC(7,4);
