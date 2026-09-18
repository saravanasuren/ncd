-- Whether LockerHub holds our agreement number yet (their A28, live 2026-09-18).
--
-- Recorded rather than assumed. The push happens AFTER the number is allocated
-- and outside that transaction — a render must never fail because LockerHub is
-- down — so a failed push has to leave a mark that a retry, a report or a person
-- can find. Without these columns a number that never reached them would look
-- identical to one that did.
ALTER TABLE locker_applications
  ADD COLUMN IF NOT EXISTS agreement_no_pushed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agreement_no_push_error  TEXT;
