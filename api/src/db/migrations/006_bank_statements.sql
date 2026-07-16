-- 006_bank_statements — statement upload + matching (docs/00 §6). The
-- authoritative "Paid" source. Idempotent; Postgres + PGlite.

CREATE TABLE IF NOT EXISTS bank_statements (
  id                 BIGSERIAL PRIMARY KEY,
  source_bank        TEXT NOT NULL DEFAULT 'Federal',
  line_count         INT NOT NULL DEFAULT 0,
  matched_count      INT NOT NULL DEFAULT 0,
  uploaded_by_user_id BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id                  BIGSERIAL PRIMARY KEY,
  statement_id        BIGINT NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  value_date          DATE NOT NULL,
  amount              NUMERIC(14,2) NOT NULL,
  reference           TEXT,
  utr                 TEXT,
  status              TEXT NOT NULL DEFAULT 'Unmatched', -- Unmatched|Matched|Ignored
  matched_schedule_id BIGINT REFERENCES disbursement_schedule(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bsl_statement ON bank_statement_lines(statement_id);
CREATE INDEX IF NOT EXISTS idx_bsl_status ON bank_statement_lines(status);
