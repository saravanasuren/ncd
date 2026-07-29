-- Acknowledgment authorised-signatory (CEO) signature image, uploadable from
-- Masters → Company profile — same model as the bond director signatures (046).
-- Replaces the hardcoded assets/authorised-signature.png the acknowledgment PDF
-- drew from, which was never supplied, so every acknowledgment printed a blank
-- signature line.
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS ack_signature_path TEXT;
