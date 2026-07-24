-- A redemption pays the REDEMPTION amount, not the interest (owner 2026-07-24).
--
-- net_payment had started folding the accrued (broken) interest into the
-- settlement, so an approval card for a ₹2,00,000 premature withdrawal read
-- ₹2,01,852.05. That contradicts the whole book: 96 of 97 live redemptions
-- have net_payment = principal − penalty exactly, interest excluded. Only the
-- one redemption created by the newer code included it.
--
-- The interest is still computed, still carries its TDS, and still becomes its
-- own BrokenInterest disbursement row — it just isn't added to the redemption
-- payment. broken_tds gets a column of its own because the settlement used to
-- DERIVE it as (net_payment − principal), which is 0 once net_payment is
-- principal-only; without storing it, the BrokenInterest row would book the
-- whole gross as tax.
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS broken_tds NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Backfill the TDS already implied by existing rows, then take the interest
-- back out of any net_payment that included it. Touches unpaid rows only —
-- a Paid redemption is history and must not be restated.
UPDATE redemptions
   SET broken_tds = GREATEST(0, round(broken_interest - (net_payment - (principal - penalty)), 2))
 WHERE broken_interest > 0
   AND net_payment > principal - penalty
   AND status <> 'Paid';

UPDATE redemptions
   SET net_payment = round(principal - penalty, 2)
 WHERE net_payment > principal - penalty
   AND status <> 'Paid';

-- The approval card reads net_payment out of the request metadata, so a
-- pending card would otherwise keep showing the old figure.
UPDATE approval_requests ar
   SET metadata = ar.metadata || jsonb_build_object('net_payment', r.net_payment)
  FROM redemptions r
 WHERE ar.entity_type = 'redemptions'
   AND ar.entity_id = r.id::text
   AND ar.status = 'Pending';
