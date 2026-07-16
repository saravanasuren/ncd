-- 001_core — identity/access, products, settings, audit, numbering (docs/02 §1–3,7).
-- Idempotent. Runs on both Postgres (prod) and PGlite (dev/test).

-- ─── Identity & access ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id          BIGINT PRIMARY KEY,          -- stable ids (seeded), not serial
  name        TEXT UNIQUE NOT NULL,
  label       TEXT NOT NULL,
  level       INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id     BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS branches (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  city        TEXT,
  district    TEXT,
  state       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                  BIGSERIAL PRIMARY KEY,
  email               TEXT UNIQUE NOT NULL,
  password_hash       TEXT,
  full_name           TEXT NOT NULL,
  phone               TEXT,
  role_id             BIGINT NOT NULL REFERENCES roles(id),
  branch_id           BIGINT REFERENCES branches(id),
  reports_to_user_id  BIGINT REFERENCES users(id),
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);

-- Branch Manager multi-branch scope (docs/03 §2).
CREATE TABLE IF NOT EXISTS user_branches (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id  BIGINT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE IF NOT EXISTS agents (
  id                        BIGSERIAL PRIMARY KEY,
  user_id                   BIGINT REFERENCES users(id),
  agent_code                TEXT UNIQUE NOT NULL,
  full_name                 TEXT NOT NULL,
  phone                     TEXT,
  email                     TEXT,
  source                    TEXT NOT NULL DEFAULT 'manual', -- manual | dhanamfin
  commission_status         TEXT NOT NULL DEFAULT 'None',   -- None|PendingApproval|Approved|Revoked
  commission_rate_setting   TEXT,                            -- settings key ref (no hardcoded rate)
  payout_mode               TEXT,
  bank_name                 TEXT,
  account_number            TEXT,
  ifsc                      TEXT,
  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh-token session families (docs/13). Access tokens are short-lived JWTs.
CREATE TABLE IF NOT EXISTS sessions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  user_agent   TEXT,
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS password_resets (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  otp_hash     TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Products & configuration ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tds_rules (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'standard', -- standard|15G|15H|custom|LDC
  rate_pct       NUMERIC(7,4) NOT NULL DEFAULT 10,
  threshold      NUMERIC(14,2),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schemes (
  id                    BIGSERIAL PRIMARY KEY,
  code                  TEXT UNIQUE NOT NULL,
  name                  TEXT NOT NULL,
  tenure_months         INT NOT NULL,
  payout_frequency      TEXT NOT NULL DEFAULT 'Monthly',
  coupon_rate_pct       NUMERIC(7,4) NOT NULL,
  face_value            NUMERIC(14,2) NOT NULL DEFAULT 100000,
  min_ticket            NUMERIC(14,2) NOT NULL DEFAULT 100000,
  multiple_of           NUMERIC(14,2) NOT NULL DEFAULT 100000,
  day_count_convention  TEXT NOT NULL DEFAULT 'Actual365',
  commission_rule       TEXT NOT NULL DEFAULT 'OneTime',
  tds_rule_id           BIGINT REFERENCES tds_rules(id),
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS series (
  id             BIGSERIAL PRIMARY KEY,
  code           TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'Open',
  face_value     NUMERIC(14,2),
  deemed_date    DATE,
  isin           TEXT,
  opened_at      TIMESTAMPTZ,
  locked_at      TIMESTAMPTZ,
  allotted_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS series_schemes (
  series_id  BIGINT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  scheme_id  BIGINT NOT NULL REFERENCES schemes(id) ON DELETE CASCADE,
  PRIMARY KEY (series_id, scheme_id)
);

CREATE TABLE IF NOT EXISTS holidays (
  d           DATE PRIMARY KEY,
  label       TEXT
);

CREATE TABLE IF NOT EXISTS banks (
  id                      BIGSERIAL PRIMARY KEY,
  account_label           TEXT NOT NULL,
  bank_name               TEXT NOT NULL,
  account_number          TEXT,
  ifsc                    TEXT,
  is_collection_account   BOOLEAN NOT NULL DEFAULT FALSE,
  is_disbursement_account BOOLEAN NOT NULL DEFAULT FALSE,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_profile (
  id                    INT PRIMARY KEY DEFAULT 1,
  legal_name            TEXT NOT NULL,
  former_legal_name     TEXT,
  short_name            TEXT NOT NULL DEFAULT 'Dhanam',
  tan                   TEXT,
  tan_holder_name       TEXT,
  tan_amendment_pending BOOLEAN NOT NULL DEFAULT FALSE,
  signatory_name        TEXT,
  signatory_designation TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT company_profile_singleton CHECK (id = 1)
);

-- The settings registry (docs/07).
CREATE TABLE IF NOT EXISTS app_settings (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  group_name    TEXT NOT NULL,
  label         TEXT NOT NULL,
  description   TEXT,
  editable_by   TEXT NOT NULL DEFAULT 'admin', -- admin | workflow
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Ops: numbering + audit ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS number_sequences (
  key         TEXT PRIMARY KEY,
  next_value  BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     BIGINT,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  before_data  JSONB,
  after_data   JSONB,
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
