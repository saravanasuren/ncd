-- 053_locker_fee_waivers — a waiver of locker RENT or DEPOSIT on an
-- application, maker-checked here before it reaches LockerHub (§A21).
--
-- Distinct from `locker_deposit_waivers` (036) and they must not be merged:
--   036 is about an EXISTING TENANCY holding a locker with no NCD backing. It
--       is purely informational — nothing settles on LockerHub.
--   this is about MONEY OWED on an application that has not been allotted yet.
--       Approving it calls §A21 and really does reduce or clear what the
--       customer pays.
--
-- LockerHub treats our call as approved-on-arrival, attributed to the approver
-- we name. So the call must happen only after OUR checker has approved — never
-- on the maker's request. `approved_by` is recorded for exactly that reason.
--
-- lockerhub_applied_at / lockerhub_error mirror 052's cheque settlement: the
-- approval is a real internal decision and stands even if their side refuses,
-- so an Approved waiver with a NULL stamp is a decision taken but not yet in
-- force — visible, and retryable (§A21 is idempotent).
--
-- Idempotent; Postgres + PGlite.

CREATE TABLE IF NOT EXISTS locker_fee_waivers (
  id                    BIGSERIAL PRIMARY KEY,
  lockerhub_application_id TEXT NOT NULL,
  leg                   TEXT NOT NULL,              -- rent | deposit
  -- Exactly one of these is set; a pct of 100 clears the leg outright.
  waiver_pct            NUMERIC(5,2),
  waiver_amount         NUMERIC(14,2),
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PendingApproval', -- PendingApproval|Approved|Rejected|Cancelled
  approval_request_id   BIGINT,
  customer_id           BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  applicant_name        TEXT,
  created_by_user_id    BIGINT REFERENCES users(id),
  approved_by_user_id   BIGINT REFERENCES users(id),
  lockerhub_applied_at  TIMESTAMPTZ,
  lockerhub_error       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live waiver per leg: two open waivers on the same rent would be two
-- reductions of the same money.
CREATE UNIQUE INDEX IF NOT EXISTS idx_locker_fee_waiver_open
  ON locker_fee_waivers (lockerhub_application_id, leg)
  WHERE status IN ('PendingApproval', 'Approved');

-- "Approved but never applied" — the chase list.
CREATE INDEX IF NOT EXISTS idx_locker_fee_waiver_unapplied
  ON locker_fee_waivers (status, lockerhub_applied_at);
