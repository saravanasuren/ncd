-- 083 — how an investment application was signed (owner 2026-09-03: "check NCD,
-- currently I only see esigning, no manual signature upload provisions").
--
-- There were none. The screen offered "Send for eSign" and "Mark eSigned", and
-- the second one stamped applications.esigned_at and nothing else: no document,
-- no method, and the word "eSigned" recorded for a form that was almost
-- certainly signed on paper. A claim we could not evidence and did not check.
--
-- Same two paths as the locker agreement (082): the Digio e-Sign unchanged, or
-- the pre-filled application form printed, signed by hand and scanned back in.
-- The investment form is ALREADY pre-filled and already carries signature boxes
-- — it is the document Digio signs — so nothing new has to be generated.
--
-- esigned_at keeps its name and its meaning of "when it was signed"; too much
-- reads it to rename safely. What changes is that it is never shown without
-- signing_method beside it.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS signing_method TEXT;              -- esign | physical | NULL (legacy)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS signed_doc_path TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS signed_doc_filename TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS signed_doc_mime TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS signed_doc_pages INT;
-- The date on the PAPER, not the day it was scanned.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS signed_on DATE;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS signed_doc_uploaded_by_user_id BIGINT REFERENCES users(id);

-- A Digio session is hard evidence of an e-Sign, so those are backfilled. Rows
-- with esigned_at but NO session were "Mark eSigned" clicks: we do not know how
-- they were signed, and they are LEFT NULL rather than guessed at. They display
-- as "Signed · method not recorded", which is the truth.
UPDATE applications a SET signing_method = 'esign'
 WHERE a.esigned_at IS NOT NULL
   AND a.signing_method IS NULL
   AND EXISTS (SELECT 1 FROM digio_signing_sessions s WHERE s.application_id = a.id);
