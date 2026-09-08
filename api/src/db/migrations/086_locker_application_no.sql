-- 086 — carry LockerHub's own application number on the list.
--
-- 085 keyed everything on their internal id (`mtr6zjq540lhmn6`), which is what
-- the API needs but not what a person can recognise. Their GET also returns
-- `application_no` — "APP-2026-01261" — which is the reference staff and the
-- customer actually see. It fills in on refresh.
--
-- Idempotent; Postgres + PGlite.

ALTER TABLE locker_applications ADD COLUMN IF NOT EXISTS application_no TEXT;

CREATE INDEX IF NOT EXISTS idx_locker_apps_no ON locker_applications (application_no);
