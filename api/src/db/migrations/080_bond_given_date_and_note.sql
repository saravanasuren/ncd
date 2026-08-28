-- 080_bond_given_date_and_note — WHEN the bond actually reached the customer,
-- and how (owner 2026-08-28).
--
-- 071 recorded only `bond_distributed_at`, stamped now() at the moment someone
-- ticked the box. That is when the RECORD was made, which is not the question
-- being asked: a bond handed over on the 20th and ticked on the 28th read as the
-- 28th, and nothing said whether it went by hand or by courier.
--
--   bond_distributed_on   the date it actually reached the customer (owner-entered)
--   bond_distributed_note how — "sent by courier, AWB 123456", "given to the son"
--
-- `bond_distributed_at` keeps its meaning unchanged — when it was recorded, and
-- the NOT NULL test for "is this marked" that the whole app already keys on.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bond_distributed_on   DATE;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bond_distributed_note TEXT;

-- Anything already marked keeps a sensible handover date instead of a blank:
-- the record date is the best evidence available for it. A no-op on production,
-- where nothing is marked yet (checked 2026-08-28) — this is for other
-- environments and for a restore of an older dump.
UPDATE applications
   SET bond_distributed_on = bond_distributed_at::date
 WHERE bond_distributed_at IS NOT NULL AND bond_distributed_on IS NULL;
