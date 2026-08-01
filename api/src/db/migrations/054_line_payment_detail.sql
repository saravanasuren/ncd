-- Per-credit payment detail on each investment line (owner 2026-08-01).
--
-- An investment can now be paid in parts and clubbed: ₹50,000 + ₹50,000 = one
-- ₹1,00,000 NCD. Each part is already its own application_lines row, but the
-- payment detail lived only on `applications` — ONE date, ONE method, ONE
-- reference, ONE receipt for the whole investment. So after clubbing you could
-- see the total and not how it was actually paid.
--
-- Worse, `attachReceipt` UPDATEs applications.receipt_file_path, so clubbing a
-- second credit REPLACED the first credit's receipt and the first became
-- unreachable. Holding the receipt per line fixes that: each part keeps its own.
--
-- applications.* keeps its columns unchanged (first credit's values, and every
-- existing report reads them) — this is additive.
ALTER TABLE application_lines ADD COLUMN IF NOT EXISTS date_money_received      DATE;
ALTER TABLE application_lines ADD COLUMN IF NOT EXISTS collection_method        TEXT;
ALTER TABLE application_lines ADD COLUMN IF NOT EXISTS collection_reference     TEXT;
ALTER TABLE application_lines ADD COLUMN IF NOT EXISTS receipt_file_path        TEXT;
ALTER TABLE application_lines ADD COLUMN IF NOT EXISTS receipt_original_filename TEXT;
ALTER TABLE application_lines ADD COLUMN IF NOT EXISTS receipt_mime             TEXT;

-- Backfill the FIRST line of each application from the application itself.
-- That is exactly right and no more: clubbing never updated applications.*, so
-- those values describe the FIRST credit. Later lines are deliberately left
-- NULL rather than guessed — the UI shows them as "—", which is honest about
-- what was never recorded, instead of stamping every part with the first
-- part's reference and inventing a paper trail.
UPDATE application_lines l
   SET date_money_received       = a.date_money_received,
       collection_method         = a.collection_method,
       collection_reference      = a.collection_reference,
       receipt_file_path         = a.receipt_file_path,
       receipt_original_filename = a.receipt_original_filename,
       receipt_mime              = a.receipt_mime
  FROM applications a
 WHERE a.id = l.application_id
   AND l.date_money_received IS NULL
   AND l.id = (SELECT min(l2.id) FROM application_lines l2 WHERE l2.application_id = a.id);
