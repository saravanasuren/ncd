-- 120 — "Date of Rollover" on the Consent for Premature Redemption.
--
-- The owner's Word file has EIGHT rows in the particulars table; the generator
-- built from it printed seven. Date of Rollover was dropped and had never
-- appeared on a letter. Asked what it should show, the owner chose to be
-- prompted at redemption time, the same answer they gave for Mode of holding.
--
-- IT CANNOT BE DERIVED, which is why it is asked rather than looked up. The
-- rollover feature in this system has never been used in production: the
-- `rollovers` table is empty and no application has source = 'rollover'. Real
-- rollovers live as six SERIES — NCD 05 Rollover … NCD 10 Rollover, 172
-- investments, 122 of them still Active — and the pre-rollover investment is
-- not in the book at all (checked: not one of those 122 holders has an
-- application in the parent series). So the only date we hold for a rolled-over
-- holding is the one in `allotment_date`, and printing that under a second
-- label would be telling the holder something the record does not actually
-- say.
--
-- OPTIONAL, unlike holding_mode. Most holdings were never rolled over, so a
-- required field here would block every ordinary redemption over a question
-- that does not apply to it. NULL prints the row blank, which is what the
-- Word file does too.
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS rollover_date DATE;

COMMENT ON COLUMN redemptions.rollover_date IS
  'The date this holding was rolled over, asked at redemption time for the consent letter. NULL = never rolled over, or nobody was asked; the letter prints the row blank.';
