-- 052_locker_cheque_settlement — record whether a cleared cheque actually
-- settled the leg on LockerHub.
--
-- Until 2026-07-29 it never could: contract v1.2 retired A10 record-payment
-- (400 `online_only`), so clearing a cheque released NCD's own hold and nothing
-- else — a staff member had to open LockerHub and mark the row paid by hand.
-- §A18 settle-offline now closes that loop.
--
-- Two calls, two systems, and the second one can fail: their API may be down,
-- or the application cancelled. The cheque is still genuinely cleared in our
-- books when that happens, so the local clear must NOT be rolled back — but the
-- divergence must be VISIBLE rather than silent, or a locker sits unsettled
-- with nobody aware. Hence a settled-at stamp and the last error, both shown in
-- the register and both drivable by a retry (their endpoint is idempotent).
--
-- NULL settled_at on a Cleared cheque = money taken, leg not settled yet. That
-- is the row someone has to chase.
-- Idempotent; Postgres + PGlite.

ALTER TABLE locker_cheques ADD COLUMN IF NOT EXISTS lockerhub_settled_at TIMESTAMPTZ;
ALTER TABLE locker_cheques ADD COLUMN IF NOT EXISTS lockerhub_error      TEXT;

-- "Which cleared cheques never settled?" — the chase list.
CREATE INDEX IF NOT EXISTS idx_locker_cheques_unsettled
  ON locker_cheques(status, lockerhub_settled_at);
