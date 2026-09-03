-- 082 — how a locker agreement was signed (owner 2026-09-03).
--
-- Until now NCD stored NOTHING about the locker agreement. LockerHub builds it,
-- uploads it to Digio, owns the status and keeps the signed PDF; our three
-- routes are pure passthrough and the profile screen re-reads their status on
-- every render. So there was no row that could hold "signed on paper" — the
-- record has to be created, not extended.
--
-- The owner wants two signing paths (2026-09-03): the existing e-Sign, and a
-- printed pre-filled agreement the customer signs by hand and staff scan back
-- in. This table is the record for BOTH, so from here on every locker agreement
-- says how it was signed rather than only the physical ones. An e-Sign row is
-- written when staff send it for signing; nothing about that flow changes.
--
-- Modelled on locker_offline_payments (077), the other "done outside LockerHub,
-- behind maker-checker, pushed to them on approval" record — same key, the
-- LockerHub application id, which is what the pledges, cheques, waivers and
-- authorised users all hang off too.
CREATE TABLE IF NOT EXISTS locker_agreement_signings (
  id                        BIGSERIAL PRIMARY KEY,
  lockerhub_application_id  TEXT NOT NULL,
  customer_id               BIGINT REFERENCES customers(id),
  -- On the row, never inferred from which columns are filled: inferring it is
  -- how you end up unable to answer "how was this signed?" in an audit.
  method                    TEXT NOT NULL,                            -- esign | physical
  status                    TEXT NOT NULL DEFAULT 'Draft',
    -- Draft | AwaitingSignature | PendingApproval | Signed | Rejected | Cancelled
    -- PendingApproval is PHYSICAL ONLY. Digio's signature is cryptographic
    -- evidence that a named person signed; a scan is evidence that somebody
    -- uploaded a file, which is exactly what a checker is for.

  -- The pre-filled agreement we generated for printing (physical path).
  form_pdf_path             TEXT,
  form_generated_at         TIMESTAMPTZ,

  -- The scan that came back.
  signed_doc_path           TEXT,
  signed_doc_filename       TEXT,
  signed_doc_mime           TEXT,
  signed_doc_pages          INT,
  -- The date on the PAPER, not the day it was scanned. The customer signs at the
  -- branch on Tuesday and someone uploads it on Friday; the agreement date is
  -- Tuesday and only the paper knows that.
  signed_on                 DATE,
  signed_at_branch          TEXT,
  witness_name              TEXT,
  note                      TEXT,

  -- e-Sign side: what LockerHub/Digio gave us, kept so the record stands even
  -- when their API is unreachable.
  esign_reference           TEXT,

  approval_request_id       BIGINT,
  lockerhub_synced_at       TIMESTAMPTZ,
  lockerhub_error           TEXT,

  created_by_user_id        BIGINT REFERENCES users(id),
  uploaded_by_user_id       BIGINT REFERENCES users(id),
  approved_by_user_id       BIGINT REFERENCES users(id),
  signed_at                 TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lock_agr_app  ON locker_agreement_signings (lockerhub_application_id);
CREATE INDEX IF NOT EXISTS idx_lock_agr_open ON locker_agreement_signings (status)
  WHERE status = 'PendingApproval';

-- One LIVE signing per locker application. A rejected or cancelled one may be
-- redone, but two competing signed agreements for one locker must not exist —
-- there would be no way to say which one governs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lock_agr_one_live
  ON locker_agreement_signings (lockerhub_application_id)
  WHERE status IN ('Draft', 'AwaitingSignature', 'PendingApproval', 'Signed');
