-- 102_redemption_utr_entry — who recorded the bank reference, and when.
--
-- Owner 2026-10-16: "only when i enter the utr number for the transaction. so
-- get me that field also."
--
-- `redemptions.utr` itself has existed since 003 and nothing has ever written
-- to it — 1 of 88 settled redemptions carries a reference, and that one arrived
-- with the wealth import. So the column is not the gap; the gap is that there
-- was no way to enter one, and no record of who did.
--
-- Entering a UTR does NOT change the redemption's status (owner's choice): it
-- records the transaction, it does not decide anything.
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS utr_entered_by_user_id BIGINT REFERENCES users(id);
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS utr_entered_at         TIMESTAMPTZ;
