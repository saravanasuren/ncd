-- Agent payout bank: the branch and the beneficiary name.
--
-- `agents` carried bank_name / account_number / ifsc and nothing else, so the
-- Agents screen had nowhere to put a branch (the IFSC names one) and no way to
-- record who the account is actually in the name of. An agent paid through a
-- family member's or a firm's account had that fact live nowhere, and a
-- transfer goes out against a beneficiary name.
--
-- Both nullable: every existing agent keeps working with them empty, and the
-- screen fills the branch automatically from the IFSC when one is entered.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS branch_name         TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS account_holder_name TEXT;
