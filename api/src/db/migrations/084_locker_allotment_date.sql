-- 084 — when a locker was REALLY allotted, and a notice that one was (owner
-- 2026-09-04: "some locker entry can be backdated too, do give a field to add
-- the date of locker allotment. and that should go be a approval when a locker
-- is being alloted, but it should [not] disturb any flow of work — just like how
-- dhanamfin app investment comes into approval but doesnt disturb any workflow").
--
-- TWO separate things, and the second one is the reason this is safe:
--
-- 1. THE DATE. LockerHub's A11 allocate takes no date; they stamp the allotment
--    and lease themselves, always "now". A locker handed over on 1 June and
--    entered in September is therefore recorded as September on their side. This
--    table holds the date staff actually state, keyed on the LockerHub
--    application id like every other locker record we keep.
--
--    Their value is kept alongside ours in `lockerhub_allotted_on` so the
--    disagreement is visible rather than hidden, and `lockerhub_synced_at` is
--    reserved for the day they accept a date on allocate (a CR is going to them
--    separately). Until then RENEWALS STILL FOLLOW THEIRS — their
--    lease_expires_on drives the rent-due screen — so a backdated locker is
--    flagged there rather than silently renewing late.
--
-- 2. THE NOTICE. Modelled exactly on `app_investment` (approvals/config.ts):
--    the allotment has ALREADY happened, the customer has the locker, and the
--    approval is a notice on the Approvals page, not a gate. There is
--    deliberately NO registerOnFinalApprove handler — approving clears the
--    notice and nothing else. Allocation itself is untouched and never waits.
CREATE TABLE IF NOT EXISTS locker_allotments (
  id                        BIGSERIAL PRIMARY KEY,
  lockerhub_application_id  TEXT NOT NULL UNIQUE,
  customer_id               BIGINT REFERENCES customers(id),
  locker_no                 TEXT,
  branch_id                 TEXT,
  branch_name               TEXT,

  -- The date staff state. Defaults to the day of entry when nothing is given,
  -- so an ordinary same-day allotment needs no extra thought.
  allotted_on               DATE NOT NULL,
  -- What LockerHub stamped, for comparison. Never overwritten by us.
  lockerhub_allotted_on     DATE,
  -- Set when allotted_on pre-dates the entry. Stored rather than derived: the
  -- entry date is not recoverable once created_at is the only witness and rows
  -- get corrected.
  backdated                 BOOLEAN NOT NULL DEFAULT FALSE,
  backdate_reason           TEXT,

  approval_request_id       BIGINT,
  allotted_by_user_id       BIGINT REFERENCES users(id),
  -- Reserved: stamped once LockerHub accepts the date on their side.
  lockerhub_synced_at       TIMESTAMPTZ,
  lockerhub_error           TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_locker_allot_backdated ON locker_allotments (backdated) WHERE backdated;
