-- 031_bond_serial_no — certificate number for the bond certificate.
-- Wealth prints a "Certificate No" (BC-{year}-{seq}); NCD had no such column so
-- the ported bond printed an em-dash. Assigned LAZILY on first generation (same
-- as wealth) so numbers are only burned on investments that actually issue one.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bond_serial_no TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_bond_serial_no
  ON applications(bond_serial_no) WHERE bond_serial_no IS NOT NULL;
