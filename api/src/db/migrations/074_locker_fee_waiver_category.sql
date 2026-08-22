-- 074 — categorise a rent write-off so reports can separate a PREMIUM customer
-- (complimentary rent) from an ordinary waiver (owner 2026-08-22). Both zero the
-- rent on LockerHub via a 100% A21 waiver — LockerHub has no other zero
-- mechanism — but NCD keeps them distinct for the rent report.
--   'waiver'   — the standard GST rent waiver + any discretionary waiver
--   'premium'  — rent made complimentary because the customer is premium
ALTER TABLE locker_fee_waivers ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'waiver';
