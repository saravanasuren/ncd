-- 088 — who may operate the locker.
--
-- The approved agreement's Schedule has carried this field all along:
--
--   5. LOCKER OPERATION MANDATES
--      Sole / Either or Survivor / Anyone or Survivor / Jointly
--
-- NCD never captured it, so it printed as the uncircled list of options on
-- every locker agreement Dhanam has signed. On a single-holder locker that is
-- academic. On a jointly-held one it is the whole question — it decides who may
-- open the locker without the others.
--
-- LockerHub specified and deployed `locker_operation_mandate` on the applicant
-- block (2026-09-09) with a fixed enumeration, refusing anything else with a
-- 400. Free text here would be a dispute about access waiting to happen, so the
-- CHECK below mirrors their four values exactly rather than trusting the caller.
--
-- NULL means "not yet chosen" and blocks nothing, which is their behaviour too:
-- every locker enrolled before today has one, and back-filling a guess onto a
-- signed contract would be worse than leaving it unstated.
--
-- Idempotent; Postgres + PGlite.

ALTER TABLE locker_applications ADD COLUMN IF NOT EXISTS operation_mandate TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'locker_applications_operation_mandate_ck'
  ) THEN
    ALTER TABLE locker_applications
      ADD CONSTRAINT locker_applications_operation_mandate_ck
      CHECK (operation_mandate IS NULL OR operation_mandate IN
        ('sole', 'either_or_survivor', 'anyone_or_survivor', 'jointly'));
  END IF;
END $$;
