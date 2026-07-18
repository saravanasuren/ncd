-- 020: Premature-redemption penalty waiver / discount (CXO approval).
--
-- At CXO approval a premature-withdrawal penalty can be waived (set to 0) or
-- discounted (reduced). We keep the original penalty + who/when/why for audit.
-- Additive + nullable, so existing redemptions are untouched.
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS penalty_original          NUMERIC(14,2);
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS penalty_waived_by_user_id BIGINT REFERENCES users(id);
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS penalty_waive_reason      TEXT;
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS penalty_waived_at         TIMESTAMPTZ;
