-- Which Dhanam bank account an investment's money was credited to. Wealth had
-- this (applications.collection_bank_id) but the migration never carried it, so
-- NCD had no record of the receiving account. Nullable — set at enrolment or
-- marked later on the investment page; a one-off script backfills the migrated
-- rows Wealth did have.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS collection_bank_id BIGINT REFERENCES banks(id);
