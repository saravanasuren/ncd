-- 077 — rent paid offline (owner 2026-08-22): staff pick a method (cheque or
-- transfer) and a reference; the rent is marked PAID only when an Admin/CXO
-- approves, and only then is it settled on LockerHub (§A18). Until then the rent
-- reads "yet to be paid" — but the locker can be allotted regardless.
--
-- Distinct from the cheque register (locker_cheques): this is the single
-- record-a-payment-then-approve flow the enrolment screen now uses for both
-- cheque and transfer.
CREATE TABLE IF NOT EXISTS locker_offline_payments (
  id                        BIGSERIAL PRIMARY KEY,
  lockerhub_application_id  TEXT NOT NULL,
  leg                       TEXT NOT NULL DEFAULT 'rent',
  method                    TEXT NOT NULL,             -- cheque | transfer
  reference                 TEXT,
  amount                    NUMERIC,
  status                    TEXT NOT NULL DEFAULT 'PendingApproval', -- PendingApproval | Approved | Rejected
  approval_request_id       BIGINT,
  lockerhub_settled_at      TIMESTAMPTZ,
  lockerhub_error           TEXT,
  created_by_user_id        BIGINT REFERENCES users(id),
  settled_by_user_id        BIGINT REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_locker_offline_pay_app ON locker_offline_payments (lockerhub_application_id);
CREATE INDEX IF NOT EXISTS idx_locker_offline_pay_open ON locker_offline_payments (status) WHERE status = 'PendingApproval';
