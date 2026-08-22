-- 075 — remember the locker number chosen at enrolment (owner 2026-08-22).
-- LockerHub's A7 create takes branch + size only (no preferred locker), so the
-- pick lived only in the browser and was lost on a resume — the allotment step
-- then re-asked. Persist it here, keyed on the LockerHub application id, and
-- restore it when the application is reopened so allotment uses it directly.
CREATE TABLE IF NOT EXISTS locker_intended_locker (
  lockerhub_application_id  TEXT PRIMARY KEY,
  locker_id                 TEXT NOT NULL,   -- LockerHub's locker id (A11 allocate takes this)
  locker_number             TEXT,            -- the human number, for display
  created_by_user_id        BIGINT REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
