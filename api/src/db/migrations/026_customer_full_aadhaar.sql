-- 026_customer_full_aadhaar — store the full 12-digit Aadhaar.
--
-- Reverses the earlier last-4-only masking (owner decision 2026-07-21) so the
-- number can be printed on the NCD application form the customer eSigns.
-- aadhaar_last4 is kept for existing reads/UI; `aadhaar` holds the full value
-- when captured, and is backfilled from the wealth app by PAN.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS aadhaar TEXT;
