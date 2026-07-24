-- A locker cheque can be recorded before the applicant has an NCD customer_id
-- at all — they only exist in LockerHub. `customer_id` stays the source of
-- truth when it's set (an active NCD customer's name can change), but for a
-- LockerHub-only applicant there is nothing to join to, so the register showed
-- a blank name forever. These carry the name/phone known at the moment the
-- cheque was taken, read only when customer_id is unset.
ALTER TABLE locker_cheques ADD COLUMN IF NOT EXISTS applicant_name  TEXT;
ALTER TABLE locker_cheques ADD COLUMN IF NOT EXISTS applicant_phone TEXT;
