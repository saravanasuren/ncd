-- 029_nominee_kyc — replace the nominee PAN field with a KYC id (owner spec
-- 2026-07-21): staff record either an Aadhaar or a PAN number for the nominee,
-- and attach a KYC photo (the photo lands in customer_documents as 'nominee_kyc').
-- The old `pan` column stays for back-compat but the wizard no longer writes it.
ALTER TABLE nominees ADD COLUMN IF NOT EXISTS kyc_id_type   TEXT;  -- 'Aadhaar' | 'PAN'
ALTER TABLE nominees ADD COLUMN IF NOT EXISTS kyc_id_number TEXT;
