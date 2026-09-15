-- 094_locker_authorised_user_aadhaar_last4 — stop storing an authorised user's
-- full Aadhaar.
--
-- Every other Aadhaar in this codebase is last-four-only by rule, stated in
-- lockers/hirers.ts: "AADHAAR IS LAST FOUR, NEVER TWELVE … Aadhaar Act 2016
-- s.29". The hirer path obeys it, the customer path obeys it, the locker
-- agreement deliberately omits Aadhaar entirely, and 091 says the full number is
-- never pushed.
--
-- Authorised users were never brought under that rule. The full twelve digits
-- were stored here, echoed to the browser by listAuthorisedUsers, rendered on
-- the enrolment screen, AND printed into the consent letter PDF that is uploaded
-- to Digio — a document any enroller could fetch by guessing a serial id.
--
-- This moves them to last-four, destroys the full numbers already at rest, and
-- makes it impossible to put one back: the CHECK means a future code change
-- cannot silently start storing twelve digits again. The old column is kept
-- (nulled) rather than dropped so this is reversible; a later migration can drop
-- it once the release has settled.
--
-- Idempotent; Postgres + PGlite.

ALTER TABLE locker_authorised_users ADD COLUMN IF NOT EXISTS aadhaar_last4 TEXT;

-- Derive from whatever is there, then destroy the full number.
UPDATE locker_authorised_users
   SET aadhaar_last4 = right(regexp_replace(COALESCE(aadhaar, ''), '[^0-9]', '', 'g'), 4)
 WHERE aadhaar_last4 IS NULL
   AND length(regexp_replace(COALESCE(aadhaar, ''), '[^0-9]', '', 'g')) >= 4;

UPDATE locker_authorised_users SET aadhaar = NULL WHERE aadhaar IS NOT NULL;

ALTER TABLE locker_authorised_users DROP CONSTRAINT IF EXISTS locker_auth_user_no_full_aadhaar_ck;
ALTER TABLE locker_authorised_users
  ADD CONSTRAINT locker_auth_user_no_full_aadhaar_ck CHECK (aadhaar IS NULL);

ALTER TABLE locker_authorised_users DROP CONSTRAINT IF EXISTS locker_auth_user_last4_ck;
ALTER TABLE locker_authorised_users
  ADD CONSTRAINT locker_auth_user_last4_ck CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$');
