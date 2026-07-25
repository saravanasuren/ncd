-- 043_escrow_statements — inbound NCD subscription money.
--
-- Distinct from bank_statements (006), which reconciles OUTGOING payouts against
-- disbursement_schedule. This is the opposite direction: subscription money that
-- lands in the single SBI escrow current account. Staff upload the SBI export
-- (a tab-separated "xls"), we parse each credit, propose who paid, and a human
-- confirms — the existing investment approval flow is untouched (owner: "flag
-- for human"). Idempotent; Postgres + PGlite.

CREATE TABLE IF NOT EXISTS escrow_statements (
  id                  BIGSERIAL PRIMARY KEY,
  account_number      TEXT,                 -- escrow account the file is for
  ifsc                TEXT,
  period_from         DATE,
  period_to           DATE,
  opening_balance     NUMERIC(16,2),
  closing_balance     NUMERIC(16,2),        -- SBI "Book/Available Balance" = the escrow balance snapshot
  line_count          INT NOT NULL DEFAULT 0,
  credit_count        INT NOT NULL DEFAULT 0,
  source_file         TEXT,                 -- original filename, audit only
  uploaded_by_user_id BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS escrow_statement_lines (
  id                   BIGSERIAL PRIMARY KEY,
  statement_id         BIGINT NOT NULL REFERENCES escrow_statements(id) ON DELETE CASCADE,
  row_no               INT NOT NULL DEFAULT 0,     -- position in the file, for stable ordering
  txn_date             DATE,
  value_date           DATE,
  amount               NUMERIC(16,2) NOT NULL,     -- signed: credit > 0, debit < 0
  direction            TEXT NOT NULL DEFAULT 'credit', -- credit|debit
  pay_type             TEXT,                       -- RTGS|NEFT|IMPS|Cheque|Internal|Other
  utr                  TEXT,                       -- UTR / bank reference parsed from narration
  remitter_account     TEXT,                       -- counterparty account (NULL / pooled for NEFT)
  remitter_account_pooled BOOLEAN NOT NULL DEFAULT FALSE,
  remitter_name        TEXT,
  cheque_no            TEXT,
  presenting_bank      TEXT,
  description          TEXT,                       -- raw narration (audit / re-parse)
  ref_no               TEXT,                       -- raw ref column (audit / re-parse)
  balance              NUMERIC(16,2),              -- running balance on the line

  -- Reconciliation state. The parser PROPOSES; a human confirms.
  match_status         TEXT NOT NULL DEFAULT 'Unmatched',
    -- Unmatched|Company|Matched|NotEnrolled|Unidentified|Flagged|Debit|Ignored
  match_method         TEXT,                       -- utr|account|name|cheque|manual
  match_confidence     TEXT,                       -- high|medium|low
  matched_customer_id  BIGINT REFERENCES customers(id),
  matched_application_id BIGINT REFERENCES applications(id),
  flag_reason          TEXT,

  -- Human sign-off (owner: flag-for-human).
  reviewed_by_user_id  BIGINT REFERENCES users(id),
  reviewed_at          TIMESTAMPTZ,

  -- Idempotent re-upload guard: the same bank line (UTR/cheque + amount + date)
  -- should never be ingested twice, even across two uploads of an overlapping
  -- statement window.
  dedupe_key           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esl_statement ON escrow_statement_lines(statement_id);
CREATE INDEX IF NOT EXISTS idx_esl_status    ON escrow_statement_lines(match_status);
CREATE INDEX IF NOT EXISTS idx_esl_customer  ON escrow_statement_lines(matched_customer_id);
CREATE INDEX IF NOT EXISTS idx_esl_utr       ON escrow_statement_lines(utr);
-- A given bank line is unique; re-uploading an overlapping window is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS uq_esl_dedupe
  ON escrow_statement_lines(dedupe_key) WHERE dedupe_key IS NOT NULL;
