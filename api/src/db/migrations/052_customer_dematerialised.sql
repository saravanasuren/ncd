-- Whether the customer's bond is held in DEMATERIALISED form. Marked manually
-- by staff — NCD does not receive this from the depository — and shown as a sign
-- on the customer profile. NULL = not yet marked, TRUE = dematerialised,
-- FALSE = physical.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_dematerialised BOOLEAN;
