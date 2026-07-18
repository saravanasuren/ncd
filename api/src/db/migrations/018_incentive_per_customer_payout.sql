-- 018: Per-customer incentive payouts.
--
-- Incentive is now paid per customer/investment (one click marks that
-- customer's accrual paid). Attribute each payout ledger row to the
-- application it settled. Nullable + additive, so existing lump-sum rows and
-- the migrate-legacy copy are untouched.
ALTER TABLE incentive_payouts ADD COLUMN IF NOT EXISTS application_id BIGINT REFERENCES applications(id);
