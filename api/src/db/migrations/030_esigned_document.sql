-- 030_esigned_document — store the SIGNED copy of the application returned by
-- Digio once eSign completes, so staff can open "Signed application" from the
-- application page (owner spec 2026-07-22). Best-effort: the path stays NULL if
-- the download fails; eSign completion is never blocked by it.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS esigned_pdf_path TEXT;
