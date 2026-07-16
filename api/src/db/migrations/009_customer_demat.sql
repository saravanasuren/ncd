-- 009_customer_demat — demat account fields on customers (docs/00 §2).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS demat_dp_id TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS demat_client_id TEXT;
