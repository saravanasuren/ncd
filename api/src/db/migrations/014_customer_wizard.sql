-- 014: Customer-enrolment wizard fields.
--
-- The staff enrolment wizard (Personal / Demat / KYC docs / Bank / Nominee /
-- Review) captures more identity, demat, bank and nominee detail than the
-- lean create form did. All additive + idempotent, so existing customers are
-- untouched and the columns stay NULL until a wizard-created record fills them.

-- Personal (customers)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS father_name       TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS occupation        TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS aadhaar_last4     TEXT;   -- UIDAI: only last 4 retained
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_secondary   TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS investor_category TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS depository        TEXT;   -- NSDL | CDSL
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ckyc_number       TEXT;

-- Bank account
ALTER TABLE customer_bank_accounts ADD COLUMN IF NOT EXISTS account_type TEXT;   -- Savings | Current
ALTER TABLE customer_bank_accounts ADD COLUMN IF NOT EXISTS branch_city  TEXT;

-- Nominee
ALTER TABLE nominees ADD COLUMN IF NOT EXISTS pan           TEXT;
ALTER TABLE nominees ADD COLUMN IF NOT EXISTS phone         TEXT;
ALTER TABLE nominees ADD COLUMN IF NOT EXISTS address       TEXT;
ALTER TABLE nominees ADD COLUMN IF NOT EXISTS guardian_name TEXT;
ALTER TABLE nominees ADD COLUMN IF NOT EXISTS guardian_pan  TEXT;
