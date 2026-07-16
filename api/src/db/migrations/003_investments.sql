-- 003_investments — applications, schedule, allotment, payouts, redemptions,
-- incentives (docs/02 §4,§5). Idempotent; Postgres + PGlite.

CREATE TABLE IF NOT EXISTS applications (
  id                        BIGSERIAL PRIMARY KEY,
  application_no            TEXT UNIQUE NOT NULL,
  customer_id               BIGINT NOT NULL REFERENCES customers(id),
  series_id                 BIGINT NOT NULL REFERENCES series(id),
  status                    TEXT NOT NULL DEFAULT 'PendingFundVerification',
  total_amount              NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_received           NUMERIC(14,2),
  date_money_received       DATE,
  collection_method         TEXT,
  collection_reference      TEXT,
  interest_start_date       DATE,
  allotment_date            DATE,
  maturity_date             DATE,
  redemption_date           DATE,
  batch_allotment_id        BIGINT,
  payout_bank_account_id    BIGINT REFERENCES customer_bank_accounts(id),
  customer_was_new_at_creation BOOLEAN NOT NULL DEFAULT TRUE,
  is_locker_deposit         BOOLEAN NOT NULL DEFAULT FALSE,
  referred_by_text          TEXT,
  source                    TEXT NOT NULL DEFAULT 'staff',
  enrolled_by_user_id       BIGINT REFERENCES users(id),
  enrolled_by_agent_id      BIGINT REFERENCES agents(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_customer ON applications(customer_id);
CREATE INDEX IF NOT EXISTS idx_app_series ON applications(series_id);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);

CREATE TABLE IF NOT EXISTS application_lines (
  id                   BIGSERIAL PRIMARY KEY,
  application_id       BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  scheme_id            BIGINT REFERENCES schemes(id),
  coupon_rate_pct      NUMERIC(7,4) NOT NULL,
  tenure_months        INT NOT NULL,
  payout_frequency     TEXT NOT NULL DEFAULT 'Monthly',
  day_count_convention TEXT NOT NULL DEFAULT 'Actual365',
  amount               NUMERIC(14,2) NOT NULL,
  outstanding_amount   NUMERIC(14,2) NOT NULL,
  maturity_date        DATE,
  status               TEXT NOT NULL DEFAULT 'Active',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_line_app ON application_lines(application_id);

CREATE TABLE IF NOT EXISTS collections (
  id                  BIGSERIAL PRIMARY KEY,
  collection_no       TEXT UNIQUE NOT NULL,
  application_id      BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  amount              NUMERIC(14,2) NOT NULL,
  method              TEXT,
  reference           TEXT,
  collection_date     DATE NOT NULL,
  confirmed_by_user_id BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS disbursement_schedule (
  id             BIGSERIAL PRIMARY KEY,
  line_id        BIGINT NOT NULL REFERENCES application_lines(id) ON DELETE CASCADE,
  application_id BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  due_date       DATE NOT NULL,
  due_type       TEXT NOT NULL,  -- Interest|BrokenInterest|Redemption|Premature
  gross_amount   NUMERIC(14,2) NOT NULL,
  tds_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_amount     NUMERIC(14,2) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'Scheduled', -- Scheduled|Paid|Failed|Skipped
  paid_at        DATE,
  utr            TEXT,
  batch_id       BIGINT,
  payee_account  TEXT,
  payee_ifsc     TEXT,
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ds_net CHECK (net_amount = gross_amount - tds_amount),
  CONSTRAINT uq_ds UNIQUE (line_id, due_date, due_type)
);
CREATE INDEX IF NOT EXISTS idx_ds_app ON disbursement_schedule(application_id);
CREATE INDEX IF NOT EXISTS idx_ds_due ON disbursement_schedule(due_date, status);

CREATE TABLE IF NOT EXISTS allotment_batches (
  id                  BIGSERIAL PRIMARY KEY,
  series_id           BIGINT NOT NULL REFERENCES series(id),
  allotment_date      DATE NOT NULL,
  isin                TEXT,
  notes               TEXT,
  approval_request_id BIGINT,
  status              TEXT NOT NULL DEFAULT 'PendingChecker',
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_batches (
  id                  BIGSERIAL PRIMARY KEY,
  batch_no            TEXT UNIQUE NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'interest', -- interest|redemption|payroll
  payout_date         DATE NOT NULL,
  total_gross         NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_tds           NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_net           NUMERIC(14,2) NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'PendingChecker',
  approval_request_id BIGINT,
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS redemptions (
  id                  BIGSERIAL PRIMARY KEY,
  redemption_no       TEXT UNIQUE NOT NULL,
  application_id      BIGINT NOT NULL REFERENCES applications(id),
  type                TEXT NOT NULL DEFAULT 'premature', -- premature|maturity
  principal           NUMERIC(14,2) NOT NULL,
  penalty             NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_payment         NUMERIC(14,2) NOT NULL,
  broken_interest     NUMERIC(14,2) NOT NULL DEFAULT 0,
  requested_date      DATE,
  redemption_date     DATE,
  reason              TEXT,
  approval_request_id BIGINT,
  utr                 TEXT,
  status              TEXT NOT NULL DEFAULT 'Requested',
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Incentives ledger ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrers (
  id                 BIGSERIAL PRIMARY KEY,
  normalized_name    TEXT UNIQUE NOT NULL,
  display_name       TEXT NOT NULL,
  eligibility_status TEXT NOT NULL DEFAULT 'PendingApproval',
  bank_name          TEXT,
  account_number     TEXT,
  ifsc               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incentive_accruals (
  id             BIGSERIAL PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  payee_type     TEXT NOT NULL,  -- staff|agent|referrer
  payee_id       BIGINT NOT NULL, -- user_id | agent_id | referrer_id
  matrix_cell    TEXT,
  rate_mode      TEXT NOT NULL,
  rate_value     NUMERIC(9,4) NOT NULL,
  amount         NUMERIC(14,2) NOT NULL,
  accrual_date   DATE NOT NULL,
  paid_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_incentive UNIQUE (application_id, payee_type, payee_id)
);
CREATE INDEX IF NOT EXISTS idx_incentive_payee ON incentive_accruals(payee_type, payee_id);

CREATE TABLE IF NOT EXISTS incentive_payouts (
  id                 BIGSERIAL PRIMARY KEY,
  payee_type         TEXT NOT NULL,
  payee_id           BIGINT NOT NULL,
  amount             NUMERIC(14,2) NOT NULL,
  reference          TEXT,
  paid_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id BIGINT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_ipayout_payee ON incentive_payouts(payee_type, payee_id);
