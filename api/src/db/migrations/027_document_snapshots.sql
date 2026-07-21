-- 027_document_snapshots — store the generated Acknowledgement + Bond so a
-- point-in-time copy exists at the moment of the lifecycle event (owner:
-- "generate + store"). Ack is generated when funds are received (application
-- goes Active); Bond right after eSign. Files live under FILE_STORAGE_DIR; the
-- path columns hold the relative location (like receipt_file_path).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS acknowledgment_pdf_path     TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS acknowledgment_generated_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bond_pdf_path               TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bond_generated_at           TIMESTAMPTZ;
