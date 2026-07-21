-- 028_customer_pincode — capture the customer's PIN code at enrolment. Entering
-- it auto-fills city + state (India Post lookup), but the PIN itself is stored
-- for records/statements. ncd previously folded the pincode into the address line.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pincode TEXT;
