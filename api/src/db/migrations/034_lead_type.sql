-- A lead can be for an NCD investment or for a locker (owner 2026-07-23).
-- NCD leads carry an interested_scheme (already present); locker leads carry a
-- locker_size. Existing rows are NCD by default so nothing changes for them.
ALTER TABLE investor_leads ADD COLUMN IF NOT EXISTS lead_type   TEXT NOT NULL DEFAULT 'ncd'; -- ncd | locker
ALTER TABLE investor_leads ADD COLUMN IF NOT EXISTS locker_size TEXT;                          -- Medium | L | XL (locker leads)
