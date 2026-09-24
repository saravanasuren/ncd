-- What the book was worth when a payout batch was cut.
--
-- The "Last batch" Outstanding on the payouts comparison was REBUILT from
-- today's book every time the screen loaded: take the live outstanding, then add
-- back what had been redeemed since, to reconstruct the past. Any figure rebuilt
-- from live data drifts, and this one did — the owner's ₹69,49,00,000 read
-- ₹69,69,00,000 two weeks later (2026-09-24).
--
-- Four redemptions raised that morning were still sitting at their full
-- outstanding, so the add-back counted their ₹20,00,000 twice: once in the live
-- figure, once in the reconstruction. Redemption STATUS is no help as a test —
-- three redemptions marked Paid still carry an outstanding balance.
--
-- A historical number should not be computed, it should be remembered. This is
-- where it is remembered: written when the batch is cut, read verbatim
-- afterwards. Nothing that happens later can move it.
ALTER TABLE payout_batches
  ADD COLUMN IF NOT EXISTS outstanding_at_payout NUMERIC(16,2);

COMMENT ON COLUMN payout_batches.outstanding_at_payout IS
  'Principal on the book when this batch was cut. Written once at creation; never recomputed.';
