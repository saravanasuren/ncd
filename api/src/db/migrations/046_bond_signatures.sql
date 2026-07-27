-- Bond certificate director signature images, uploadable from Masters →
-- Company profile instead of hardcoded (and never-supplied) asset files.
-- One column per certificate signature slot (docs/00 bond.ts DIRECTORS order).
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS bond_signature_1_path TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS bond_signature_2_path TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS bond_signature_3_path TEXT;
