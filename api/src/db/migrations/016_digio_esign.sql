-- 016_digio_esign — Digio eSign signing sessions. eSign is OFF ncd's critical
-- path (activation is decoupled); this records signing progress and stamps
-- applications.esigned_at on completion. Dormant until DIGIO_* creds land.
CREATE TABLE IF NOT EXISTS digio_signing_sessions (
  id                 BIGSERIAL PRIMARY KEY,
  application_id     BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  digio_request_id   TEXT UNIQUE,
  sign_url           TEXT,
  signer_email       TEXT,
  signer_phone       TEXT,
  status             TEXT NOT NULL DEFAULT 'requested', -- requested|signed|failed|expired
  signed_at          TIMESTAMPTZ,
  signed_document_url TEXT,
  webhook_payload    JSONB,
  created_by_user_id BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_digio_sessions_app ON digio_signing_sessions (application_id);
CREATE INDEX IF NOT EXISTS idx_digio_sessions_open ON digio_signing_sessions (status) WHERE status = 'requested';
