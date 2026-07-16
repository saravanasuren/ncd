-- 005_redemption_events — customer-requested redemptions + rollover/transfer/
-- transformation lineage (docs/00 §6). Idempotent; Postgres + PGlite.

ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff'; -- staff|portal|lockerhub
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS requested_by_customer BOOLEAN NOT NULL DEFAULT FALSE;

-- Rollover: an application matures and its principal is re-invested into a new one.
CREATE TABLE IF NOT EXISTS rollovers (
  id                  BIGSERIAL PRIMARY KEY,
  rollover_no         TEXT UNIQUE NOT NULL,
  from_application_id BIGINT NOT NULL REFERENCES applications(id),
  to_application_id   BIGINT REFERENCES applications(id),
  amount              NUMERIC(14,2) NOT NULL,
  approval_request_id BIGINT,
  status              TEXT NOT NULL DEFAULT 'Requested',
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Holder transfer: ownership of an NCD moves from one customer to another.
CREATE TABLE IF NOT EXISTS ncd_transfers (
  id                  BIGSERIAL PRIMARY KEY,
  transfer_no         TEXT UNIQUE NOT NULL,
  application_id      BIGINT NOT NULL REFERENCES applications(id),
  from_customer_id    BIGINT NOT NULL REFERENCES customers(id),
  to_customer_id      BIGINT NOT NULL REFERENCES customers(id),
  reason              TEXT,
  approval_request_id BIGINT,
  status              TEXT NOT NULL DEFAULT 'Requested',
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transformation: on a holder's death, the NCD passes to the nominee.
CREATE TABLE IF NOT EXISTS ncd_transformations (
  id                  BIGSERIAL PRIMARY KEY,
  transformation_no   TEXT UNIQUE NOT NULL,
  application_id      BIGINT NOT NULL REFERENCES applications(id),
  deceased_customer_id BIGINT NOT NULL REFERENCES customers(id),
  nominee_name        TEXT NOT NULL,
  nominee_customer_id BIGINT REFERENCES customers(id),
  nominee_bank_name   TEXT,
  nominee_account     TEXT,
  nominee_ifsc        TEXT,
  approval_request_id BIGINT,
  status              TEXT NOT NULL DEFAULT 'Requested',
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
