-- 091 — the full 12-digit Aadhaar for a JOINT hirer (owner 2026-09-12: "get all
-- the 12 digits of aadhar for the joint applicant also").
--
-- 089 stored last-4 only for a hirer and said a full number "must never be
-- stored here". That was written when the locker agreement was LockerHub's and
-- a hirer was, to us, a name to print. Two things changed:
--
--   · #421 moved the agreement to OUR document and OUR Digio, and #427 made
--     every joint hirer an actual SIGNATORY of it. A joint hirer is now a KYC
--     subject of ours in the same way the primary customer is.
--   · the primary customer's full Aadhaar has been stored since 026, taken on
--     the owner's 2026-07-21 decision for exactly this reason — so it can be
--     carried on the document they eSign. A joint hirer signing the same
--     agreement is the same case.
--
-- WHAT DOES NOT CHANGE, and is the part worth guarding: the full number is
-- never PUSHED. LockerHub rejects twelve digits outright and is not permitted
-- to hold one (Aadhaar Act 2016 s.29), so hirersForLockerHub keeps sending
-- last-4 alone. That is a structural rule with a test on it, not a convention.
--
-- Mirrors customers exactly: `aadhaar` holds the full value when captured,
-- `aadhaar_last4` stays the display/push field and is DERIVED from it.
--
-- Idempotent; Postgres + PGlite.

ALTER TABLE locker_application_hirers ADD COLUMN IF NOT EXISTS aadhaar TEXT;

-- Twelve digits or nothing. A partial number is worse than none: it reads as a
-- captured Aadhaar while being unusable, and last-4 derived from it would be
-- wrong.
ALTER TABLE locker_application_hirers DROP CONSTRAINT IF EXISTS locker_hirer_aadhaar12_ck;
ALTER TABLE locker_application_hirers
  ADD CONSTRAINT locker_hirer_aadhaar12_ck CHECK (aadhaar IS NULL OR aadhaar ~ '^[0-9]{12}$');
