-- 008_application_receipt — receipt photo on applications (docs/00 §4).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS receipt_file_path TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS receipt_original_filename TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS receipt_mime TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS receipt_uploaded_at TIMESTAMPTZ;
