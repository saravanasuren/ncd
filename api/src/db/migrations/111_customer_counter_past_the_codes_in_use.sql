-- The customer counter must stand ahead of every code already in use.
--
-- Migration 110 moved seven customers forward off staff codes, into DHN1069
-- through DHN1075, and left the counter at 1069. customers.customer_code is
-- uniquely indexed and nothing retries a duplicate on the enrolment path, so
-- the next customer created would have been handed a code one of those seven
-- now wears and the enrolment would have failed outright.
--
-- Forward only. The counter is never pulled back, because a lower counter
-- re-issues codes that have already been printed on acknowledgements.
--
-- lib/sequences.ts now also asks the customers table whether a candidate is
-- free, so a counter behind the book can no longer issue a duplicate whatever
-- put it there — a repair like 110, a restored backup, a hand-typed code. This
-- migration closes the gap that already exists; that check keeps it closed.

DO $$
DECLARE
  cur   bigint;
  want  bigint;
BEGIN
  SELECT next_value INTO cur FROM number_sequences WHERE key = 'customer';
  IF cur IS NULL THEN
    RAISE NOTICE 'migration 111: no customer sequence yet, nothing to realign';
    RETURN;
  END IF;

  -- One past the highest DHN code any customer holds. Staff codes are left out
  -- deliberately: the generator steps over those as it meets them, and jumping
  -- the counter past DHN1354 would burn 280 customer numbers.
  SELECT COALESCE(max(NULLIF(regexp_replace(customer_code, '^DHN', ''), '')::bigint), 0) + 1
    INTO want
    FROM customers
   WHERE customer_code ~ '^DHN[0-9]+$';

  IF want > cur THEN
    UPDATE number_sequences SET next_value = want WHERE key = 'customer';
    RAISE NOTICE 'migration 111: customer counter moved % -> %', cur, want;
  ELSE
    RAISE NOTICE 'migration 111: customer counter already ahead of the book (at %)', cur;
  END IF;

  -- Post-check: the next code out must not already belong to anyone.
  IF EXISTS (
    SELECT 1 FROM customers
     WHERE customer_code = 'DHN' || lpad(
       (SELECT next_value FROM number_sequences WHERE key = 'customer')::text, 4, '0')
  ) THEN
    RAISE EXCEPTION 'post-check: the next customer code is already in use';
  END IF;
END $$;
