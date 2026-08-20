-- Has the bond certificate actually been handed to the customer? (owner
-- 2026-08-19: "get me a option in the investment application section to make
-- is the bond has been distributed to the customer or not").
--
-- Distinct from every existing bond field: the consolidated bond is a document
-- we can GENERATE at any time, and esigned/bond_pdf_path record what was
-- produced — none of them say whether the customer physically received it.
--
-- Timestamp rather than a boolean, so "when" comes free; NULL = not handed over.
-- The staff member who marked it is kept because months later the only question
-- that matters is who says this customer got their bond.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bond_distributed_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bond_distributed_by BIGINT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_applications_bond_distributed
  ON applications(bond_distributed_at) WHERE bond_distributed_at IS NULL;
