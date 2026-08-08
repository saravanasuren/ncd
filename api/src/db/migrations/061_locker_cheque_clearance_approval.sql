-- 061_locker_cheque_clearance_approval — cheque clearance goes through Approvals.
--
-- Clearing a locker cheque used to be a direct action on the enrollment page
-- (`applications:confirm-collection`). It now becomes a maker-checker step: a
-- maker marks "funds cleared" (raising a `locker_cheque_clearance` approval), and
-- an Admin/CXO checker approves it — only then does the cheque clear and settle
-- on LockerHub (owner 2026-08-07).
--
-- No status-vocabulary change: a cheque stays 'Pending' while its approval is
-- open (tracked by approval_request_id) and flips to 'Cleared' only on approval,
-- so the existing CHECK and the one-live-cheque-per-leg index still hold.
-- Idempotent; Postgres + PGlite.

ALTER TABLE locker_cheques
  ADD COLUMN IF NOT EXISTS approval_request_id BIGINT REFERENCES approval_requests(id);

CREATE INDEX IF NOT EXISTS idx_locker_cheques_approval
  ON locker_cheques(approval_request_id) WHERE approval_request_id IS NOT NULL;
