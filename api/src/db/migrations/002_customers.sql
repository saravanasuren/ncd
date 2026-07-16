-- 002_customers — leads, customers, relations, approvals (docs/02 §2, §7).
-- Idempotent. Runs on Postgres (prod) + PGlite (dev/test).

-- ─── Leads (CRM) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS investor_leads (
  id                     BIGSERIAL PRIMARY KEY,
  full_name              TEXT NOT NULL,
  phone                  TEXT,
  place                  TEXT,
  district               TEXT,
  category               TEXT,
  source                 TEXT,
  referred_by_text       TEXT,
  interested_scheme      TEXT,
  expected_amount        NUMERIC(14,2),
  follow_up_date         DATE,
  status                 TEXT NOT NULL DEFAULT 'New',
  notes                  TEXT,
  admin_only             BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id     BIGINT REFERENCES users(id),
  created_by_agent_id    BIGINT REFERENCES agents(id),
  branch_id              BIGINT REFERENCES branches(id),
  converted_customer_id  BIGINT,
  lockerhub_application_no TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_creator ON investor_leads(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_leads_agent ON investor_leads(created_by_agent_id);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON investor_leads(phone);

CREATE TABLE IF NOT EXISTS lead_notes (
  id                 BIGSERIAL PRIMARY KEY,
  lead_id            BIGINT NOT NULL REFERENCES investor_leads(id) ON DELETE CASCADE,
  note               TEXT NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Customers ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id                   BIGSERIAL PRIMARY KEY,
  customer_code        TEXT UNIQUE NOT NULL,
  full_name            TEXT NOT NULL,
  pan                  TEXT UNIQUE,
  dob                  DATE,
  gender               TEXT,
  phone                TEXT,
  email                TEXT,
  address              TEXT,
  city                 TEXT,
  district             TEXT,
  state                TEXT,
  is_nri               BOOLEAN NOT NULL DEFAULT FALSE,
  tax_form             TEXT,
  tax_form_expires_on  DATE,
  tds_applicable       BOOLEAN NOT NULL DEFAULT TRUE,
  referred_by_text     TEXT,
  kyc_status           TEXT NOT NULL DEFAULT 'Pending',
  creation_status      TEXT NOT NULL DEFAULT 'Draft', -- Draft|PendingApproval|Approved
  enrolled_by_user_id  BIGINT REFERENCES users(id),
  enrolled_by_agent_id BIGINT REFERENCES agents(id),
  branch_id            BIGINT REFERENCES branches(id),
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  is_deceased          BOOLEAN NOT NULL DEFAULT FALSE,
  deceased_date        DATE,
  portal_user_id       BIGINT REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_enroller ON customers(enrolled_by_user_id);
CREATE INDEX IF NOT EXISTS idx_customers_agent ON customers(enrolled_by_agent_id);
CREATE INDEX IF NOT EXISTS idx_customers_branch ON customers(branch_id);
CREATE INDEX IF NOT EXISTS idx_customers_district ON customers(district);

CREATE TABLE IF NOT EXISTS customer_bank_accounts (
  id                 BIGSERIAL PRIMARY KEY,
  customer_id        BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  account_number     TEXT NOT NULL,
  ifsc               TEXT,
  bank_name          TEXT,
  branch_name        TEXT,
  holder_name        TEXT,
  penny_drop_status  TEXT NOT NULL DEFAULT 'Pending', -- Pending|Verified|Failed
  penny_drop_detail  TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cba_customer ON customer_bank_accounts(customer_id);
-- one active account per customer
CREATE UNIQUE INDEX IF NOT EXISTS uq_cba_one_active
  ON customer_bank_accounts(customer_id) WHERE is_active = TRUE;
-- dedup guard: same account+ifsc once per customer
CREATE UNIQUE INDEX IF NOT EXISTS uq_cba_dedup
  ON customer_bank_accounts(customer_id, account_number, ifsc);

CREATE TABLE IF NOT EXISTS joint_holders (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  full_name    TEXT NOT NULL,
  pan          TEXT,
  phone        TEXT,
  relationship TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nominees (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  full_name    TEXT NOT NULL,
  relationship TEXT,
  share_pct    NUMERIC(5,2),
  dob          DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_documents (
  id                 BIGSERIAL PRIMARY KEY,
  customer_id        BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  doc_type           TEXT NOT NULL,
  file_path          TEXT NOT NULL,
  original_filename  TEXT,
  mime               TEXT,
  origin             TEXT NOT NULL DEFAULT 'staff', -- staff|dhanamfin
  uploaded_by_user_id BIGINT REFERENCES users(id),
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_change_requests (
  id                  BIGSERIAL PRIMARY KEY,
  customer_id         BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  changes             JSONB NOT NULL,
  reason              TEXT,
  source              TEXT NOT NULL DEFAULT 'staff', -- staff|portal|lockerhub
  approval_request_id BIGINT,
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_reassignments (
  id                  BIGSERIAL PRIMARY KEY,
  customer_id         BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  from_user_id        BIGINT REFERENCES users(id),
  to_user_id          BIGINT REFERENCES users(id),
  reason              TEXT,
  approval_request_id BIGINT,
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Approvals (generic maker-checker) ───────────────────────────────
CREATE TABLE IF NOT EXISTS approval_requests (
  id            BIGSERIAL PRIMARY KEY,
  request_no    TEXT UNIQUE NOT NULL,
  request_type  TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  level         INT NOT NULL DEFAULT 1,    -- current level awaiting action
  max_levels    INT NOT NULL DEFAULT 1,
  chain         JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{level, checkerPermission}]
  status        TEXT NOT NULL DEFAULT 'Pending',    -- Pending|Approved|Rejected
  maker_user_id BIGINT REFERENCES users(id),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status, request_type);

CREATE TABLE IF NOT EXISTS approval_actions (
  id                  BIGSERIAL PRIMARY KEY,
  approval_request_id BIGINT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  level               INT NOT NULL,
  approver_user_id    BIGINT NOT NULL REFERENCES users(id),
  action              TEXT NOT NULL, -- approve|reject
  reason              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
