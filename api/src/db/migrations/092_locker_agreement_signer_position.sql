-- 092 — WHICH hirer a signing session belongs to (owner 2026-09-14: "i need
-- different buttons for each esigning... first the primary holder hirer 1
-- esigns and then follow the rest of hirer according to how many are there").
--
-- #427 put every hirer on ONE Digio request, so all of them were invited at
-- once and the screen had one button and one status for the lot. The owner
-- wants a button and a visible state per person, signed in order.
--
-- So a locker agreement becomes a CHAIN of sessions over ONE document: hirer 1
-- signs the rendered agreement, hirer 2 signs the file hirer 1 produced, hirer
-- 3 signs that, then the CEO. Each stage carries the signatures before it —
-- "one single application for all esigning", not a fresh agreement each time.
-- The CEO stage has always worked this way (it signs getSignedDocument()), so
-- this generalises a proven mechanism rather than inventing one.
--
-- NULL for every other document type, and for the CEO stage, which is
-- identified by document_type = 'locker_agreement_ceo' as before.
--
-- Idempotent; Postgres + PGlite.

ALTER TABLE digio_signing_sessions ADD COLUMN IF NOT EXISTS signer_position SMALLINT;

-- One live session per hirer per agreement. A re-send cancels the old row
-- first (the code does), so this catches a double-send racing itself rather
-- than legitimate history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_digio_locker_agreement_signer
  ON digio_signing_sessions (locker_agreement_signing_id, signer_position)
  WHERE locker_agreement_signing_id IS NOT NULL
    AND signer_position IS NOT NULL
    AND status <> 'cancelled';

-- WHOSE signatures the stored file already carries.
--
-- Each stage signs the file the stage before produced. If a download fails
-- mid-chain the stored file is still the EARLIER copy — and the next hirer
-- would sign that, silently dropping the signature in between. Recording which
-- position the file reflects lets the next stage refuse instead of quietly
-- producing an agreement missing a signatory.
ALTER TABLE locker_agreement_signings ADD COLUMN IF NOT EXISTS signed_doc_position SMALLINT;
