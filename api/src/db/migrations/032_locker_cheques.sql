-- 032_locker_cheques — NCD-side register of cheques taken for a locker.
--
-- Lockers are ONLINE-ONLY on LockerHub (contract v1.2 §A10 retired offline
-- record-payment), so NCD cannot settle a locker leg with a cheque. High-value
-- customers still hand over cheques and expect the locker opened, so this table
-- records the instrument and its clearance for OUR books and audit only.
--
-- Clearing a row here releases NCD's own hold. It does NOT settle the leg on
-- LockerHub and does NOT allot the locker — that still needs A9 (payment link)
-- or A12 (back the deposit with an NCD investment).
CREATE TABLE IF NOT EXISTS locker_cheques (
  id                        BIGSERIAL PRIMARY KEY,
  lockerhub_application_id  TEXT   NOT NULL,
  customer_id               BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  leg                       TEXT   NOT NULL CHECK (leg IN ('rent','deposit')),
  amount                    NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  cheque_no                 TEXT   NOT NULL,
  bank_name                 TEXT,
  received_on               DATE   NOT NULL,
  status                    TEXT   NOT NULL DEFAULT 'Pending'
                              CHECK (status IN ('Pending','Cleared','Bounced','Cancelled')),
  cleared_on                DATE,
  reference                 TEXT,
  notes                     TEXT,
  recorded_by_user_id       BIGINT REFERENCES users(id),
  settled_by_user_id        BIGINT REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_locker_cheques_app    ON locker_cheques(lockerhub_application_id);
CREATE INDEX IF NOT EXISTS idx_locker_cheques_status ON locker_cheques(status);
-- One live cheque per (locker application, leg) — re-recording after a bounce is
-- fine, but two Pending cheques for the same leg is always a mistake.
CREATE UNIQUE INDEX IF NOT EXISTS idx_locker_cheques_one_live
  ON locker_cheques(lockerhub_application_id, leg) WHERE status = 'Pending';
