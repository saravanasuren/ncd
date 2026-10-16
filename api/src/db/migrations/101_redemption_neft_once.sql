-- 101_redemption_neft_once — a redemption's NEFT instruction leaves the building ONCE.
--
-- Owner 2026-10-16: "once i approve it i see the neft can be downloaded from the
-- redemption section - but it can be downloaded multiple times. keep it as
-- downloaded only once. only super admin will have the access to download it
-- again."
--
-- The sheet IS the instruction to pay. Two copies of the same line is how a
-- customer gets paid twice, and nothing downstream would catch it: the UTR is
-- only written after the bank confirms, so between download and confirmation
-- the row looked freshly payable every time someone clicked.
--
-- A count rather than a boolean: "who pulled this a second time, and when"
-- is the question asked after a double payment, and a flag cannot answer it.
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS neft_downloaded_at        TIMESTAMPTZ;
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS neft_downloaded_by_user_id BIGINT REFERENCES users(id);
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS neft_download_count       INT NOT NULL DEFAULT 0;

-- Existing redemptions are left UNMARKED on purpose. Marking them would be a
-- guess about files that may or may not have been pulled before today, and the
-- guess that locks people out is the expensive one.
