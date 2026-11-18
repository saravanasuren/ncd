-- 117 — how a redemption request letter was signed (owner 2026-11-18).
--
-- Until now a premature redemption went from "staff pressed Redeem early"
-- straight into the two-level approval, in ONE call: initiatePremature created
-- the record and submitted it. Nothing the customer signed stood between the
-- two. The owner wants the customer's own signed request letter to be that
-- gate, on paper or through Digio, before any approver sees it.
--
-- Modelled on locker_agreement_signings (082), the other "two signing paths,
-- one record, physical needs a human to look at it" table. Same shape, same
-- reasons, so the two read alike when somebody has to audit either.
--
-- ONE DIFFERENCE FROM THE LOCKER MODEL, deliberate: a locker scan raises its
-- OWN approval request, because the agreement is the only thing being approved.
-- A redemption already has an approval — the redemption itself — and the owner
-- asked for the approver to check the signature AS PART OF it, not in a second
-- queue. So there is no approval_request_id here; the signature gates entry to
-- the redemption's existing approval and the approver sees both together.
CREATE TABLE IF NOT EXISTS redemption_signings (
  id                     BIGSERIAL PRIMARY KEY,
  redemption_id          BIGINT NOT NULL REFERENCES redemptions(id) ON DELETE CASCADE,

  -- On the row, never inferred from which columns are filled — the locker
  -- table's note applies word for word: inferring it is how you end up unable
  -- to answer "how was this signed?" in an audit.
  method                 TEXT,                       -- esign | physical | NULL until chosen
  status                 TEXT NOT NULL DEFAULT 'Draft',
    -- Draft | AwaitingSignature | Signed | Superseded | Cancelled

  -- The letter we generated for this signature. Stored rather than regenerated
  -- on demand because the customer signed THIS file: regenerating it later
  -- would silently produce a different document if a bank account, a name or
  -- the format itself changed in between.
  letter_pdf_path        TEXT,
  letter_generated_at    TIMESTAMPTZ,

  -- WHAT THE CUSTOMER ACTUALLY AGREED TO, frozen at the moment of signing.
  --
  -- The approver may still waive the penalty or move the redemption date, and
  -- the date recomputes the broken-period interest. The owner's rule (asked
  -- 2026-11-18) is that the letter then voids and the customer signs a fresh
  -- one. These three columns are what makes that decidable instead of a guess:
  -- compare them with the redemption as it stands now and a divergence is a
  -- fact, not an inference from timestamps.
  signed_principal       NUMERIC(14,2),
  signed_penalty         NUMERIC(14,2),
  signed_redemption_date DATE,

  -- The scan that came back (physical path).
  signed_doc_path        TEXT,
  signed_doc_filename    TEXT,
  signed_doc_mime        TEXT,
  signed_doc_pages       INT,
  -- The date on the PAPER, not the day it was scanned — the customer signs at
  -- the branch on Tuesday and someone uploads it on Friday.
  signed_on              DATE,
  note                   TEXT,

  -- e-Sign side, filled by the Digio path. Kept so the record stands even when
  -- their API is unreachable.
  digio_request_id       TEXT,
  sign_url               TEXT,

  signed_at              TIMESTAMPTZ,
  superseded_at          TIMESTAMPTZ,
  superseded_reason      TEXT,

  created_by_user_id     BIGINT REFERENCES users(id),
  uploaded_by_user_id    BIGINT REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_red_sign_redemption ON redemption_signings (redemption_id);
CREATE INDEX IF NOT EXISTS idx_red_sign_digio ON redemption_signings (digio_request_id)
  WHERE digio_request_id IS NOT NULL;

-- One LIVE signature attempt per redemption. A superseded or cancelled one is
-- kept — it is the evidence of what was signed and why it stopped counting —
-- but two competing live letters for one redemption must not exist, or there
-- is no answering which one the customer agreed to.
CREATE UNIQUE INDEX IF NOT EXISTS idx_red_sign_one_live
  ON redemption_signings (redemption_id)
  WHERE status IN ('Draft', 'AwaitingSignature', 'Signed');

-- EVERY REDEMPTION THAT ALREADY EXISTS IS LEFT ALONE.
--
-- 151 redemptions are on the book and every one of them is already Approved,
-- Paid, Rejected or Cancelled — none is mid-flight (checked against production
-- on 2026-11-18, zero rows in 'Requested'). Backfilling a signing row for them
-- would invent a signature nobody gave, and gating them would strand money
-- that has in several cases already left the bank. The gate added with this
-- migration therefore applies only to redemptions raised from here on, which
-- is possible precisely because the queue happened to be empty.
