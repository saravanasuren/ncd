-- Repair redemptions RAISED BEFORE the principal-only rule (#122).
--
-- 035_redemption_broken_tds.sql added the column and the code stopped folding
-- broken-period interest into net_payment — but only for redemptions created
-- from then on. Rows already sitting in the queue keep the bundled figure:
-- live, MCR-2026-000042 (P Sarasu, APP-2026-000572) is still 'Requested' at
-- ₹2,01,852.05 for a ₹2,00,000 withdrawal, which is the number the owner saw
-- on the approval card.
--
-- Recover the TDS the old arithmetic implied (net_payment − principal was the
-- interest NET of tax, so gross − that = the tax), then take the interest back
-- out of net_payment. Paid redemptions are history and are left alone.
UPDATE redemptions
   SET broken_tds = GREATEST(0, round(broken_interest - (net_payment - (principal - penalty)), 2))
 WHERE broken_interest > 0
   AND net_payment > principal - penalty
   AND status <> 'Paid'
   AND broken_tds = 0;

UPDATE redemptions
   SET net_payment = round(principal - penalty, 2)
 WHERE net_payment > principal - penalty
   AND status <> 'Paid';

-- The approval card renders net_payment out of the request metadata, so a
-- pending card would keep showing the bundled figure even after the row is
-- corrected.
UPDATE approval_requests ar
   SET metadata = ar.metadata || jsonb_build_object('net_payment', r.net_payment)
  FROM redemptions r
 WHERE ar.entity_type = 'redemptions'
   AND ar.entity_id = r.id::text
   AND ar.status = 'Pending';
